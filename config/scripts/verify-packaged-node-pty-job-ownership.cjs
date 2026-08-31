const { createRequire } = require('node:module')
const { join } = require('node:path')
const { assertNodePtyJobOwnership } = require('./node-pty-job-ownership.cjs')

function loadPackagedConpty(resourcesDir) {
  const packagedRequire = createRequire(join(resourcesDir, 'package.json'))
  const { loadNativeModule } = packagedRequire('./node_modules/node-pty/lib/utils')
  return loadNativeModule('conpty')
}

function verifyPackagedNodePtyJobOwnership(resourcesDir, options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    return
  }

  const native = (options.loadNative ?? loadPackagedConpty)(resourcesDir)
  assertNodePtyJobOwnership({ platform, nativeName: 'conpty', native })
  if (!native.dir.replace(/\\/g, '/').includes('build/Release/')) {
    throw new Error(`Packaged node-pty resolved to ${native.dir}; expected patched build/Release`)
  }
  console.log('[verify-packaged-node-pty] OK — packaged ConPTY owns process trees')
}

module.exports = { verifyPackagedNodePtyJobOwnership }
