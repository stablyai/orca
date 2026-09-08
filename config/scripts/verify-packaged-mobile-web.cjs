const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join, resolve } = require('node:path')

function verifyPackagedMobileWeb(resourcesDir, options = {}) {
  const packageRoot = join(resourcesDir, 'mobile-web')
  if (!existsSync(join(packageRoot, 'manifest.json'))) {
    throw new Error(`Packaged mobile web manifest is missing: ${packageRoot}`)
  }
  const verifierPath = options.verifierPath ?? resolve(__dirname, 'verify-mobile-web-rnw-build.mjs')
  const run = options.execFileSync ?? execFileSync
  run(
    process.execPath,
    ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', verifierPath, '--root', packageRoot],
    { stdio: 'inherit' }
  )
  return packageRoot
}

module.exports = { verifyPackagedMobileWeb }
