var
async = require('async'),
fs = require('fs'),
path = require('path'),
cleanCss = require('clean-css'),
terser = require('terser');

exports.middleware = function(options) {
  var bundles = {};

  var emit = function(name) {
    // emit bundled file
    return [
      name
    ];
  };

  if (options.env === 'development'){
    emit = function(name) {
      // emit each file in bundle
      return bundles[name].files.map(function(file) {
        return file.name;
      });
    };
  }

  if (options.attachTo){
    options.attachTo.bundles = {};
    options.attachTo.bundles.emit = emit;
  }


  options.hooks = options.hooks ? options.hooks : {};
  Object.keys(options.bundles).forEach(function(name) {
    var files = options.bundles[name].map(function(name) {
      var file = {
        name: name
      };
      if (/^https?\:/.test(name)){
        file.path = name;
        file.getModifiedTime = false;
        file.read = function(done){
          var request = require('request');

          request.get(this.path, {}, function (error, response, body) {
            if (response.statusCode === 200) {
              if (error) {
                return done(error);
              };
              done(null, body);
            }
            else {
              return done(error);
            }
          });
        };
      }
      else {
        file.path = path.join(options.src, name);
        file.getModifiedTime = function(){
          return fs.statSync(this.path).mtime;
        }
        file.read = function(done){
          fs.readFile(this.path, {
            encoding: 'utf8'
          }, function(err, data){
            done(err, data);
          });
        };
      }

      return file;
    });
    bundles[name] = {
      name: name,
      path: path.join(options.src, name),
      files: files
    }
  });

  // Checks if any file under @bundle has changed
  function check(bundle, done) {
    async.some(bundle.files, function(file, done) {
      var bundle = bundles[file.name]
      if(bundle) {
        // @file is another bundle, check it
        check(bundle, function(err, changed) {
          done(changed)
        })
        return
      }

      // Compare mtime
      if (file.getModifiedTime){
        file.ttime = file.getModifiedTime();
        done(!file.mtime || file.ttime - file.mtime);
      }
      else{
        done(null, false);
      }
    }, function(changed) {
      done(null, changed)
    });
  }

  function build(bundle, done) {
    // check bundle for change
    check(bundle, function(err, changed) {

      if(err) {
        done(err)
        return
      }

      if(!changed && fs.existsSync(bundle.path)) {
        // @bundle hasn't changed, rebuild unnecessary
        done()
        return
      }

      // merge all file data
      async.map(bundle.files, function(file, done) {
        var bundle = bundles[file.name]
        if(bundle) {
          // @file is a bundle, build it
          build(bundle, function(err, data) {
            if(err) {
              done(err);
              return;
            }

            // read file, add to memo
            fs.readFile(bundle.path, {
              encoding: 'utf8'
            }, function(err, data) {
              if(err) {
                done(err);
                return;
              }
              done(null, data);
            })
          });
          return;
        }

        file.read(function(err, data) {
          if (err) {
            done(err);
            return;
          }

          var ext = path.extname(file.name)

          var hook = options.hasOwnProperty("hooks") ? options.hooks[ext] : null
          if(hook) {
            // hook defined, use it
            hook(file, data, function(err, data) {
              if (err) {
                console.log(err);
                done(err);
                return;
              }
              done(null, data);
            });
            return;
          }

          done(null, data)
        });
      }, function(err, results) {
        if(err) {
          done(err)
          return
        }

        // update each file's mtime
        bundle.files.forEach(function(file) {
          file.mtime = file.ttime
        })

        // save bundle
        save(bundle.name, results, function(err) {
          if(err) {
            done(err)
            return
          }
          done(null, results)
        })
      })
    })
  }

  function save(name, data, done) {
    switch(path.extname(name)) {
    case '.css':
      // minify css
      data = cleanCss.process(data.join('\n'));
      fs.writeFile(path.join(options.src, name), data, done);
      break;

    case '.html':
      fs.writeFile(path.join(options.src, name), data.join("\n"), done);
      break;

    case '.js':
      const onError = error => {
				console.error('Error minifying js file.', name);
				console.error(error);
      }

      // mangle and minify js
      const inputData = Array.isArray(data) ? data.join('') : data

      try {
        const output = terser.minify(inputData, options.terser)

        if (output.error) {
          onError(output.error)
          break;
        }

        fs.writeFile(path.join(options.src, name), output.code, done);
      } catch (err) {
        onError(err)
        break;
      }
      break;
    }
  }

  return function(req, res, next) {

    if (!options.attachTo) {
      res.locals.bundles = {};
      res.locals.bundles.emit = emit;
    }

    var bundle = bundles[path.relative('/', req.url)] || bundles[path.relative('/', req.url).replace("\\","/")];

    if(!bundle) {
      // not a bundle, skip it
      next();
      return;
    }

    build(bundle, function(err) {
      next(err);
    })
  }
}
