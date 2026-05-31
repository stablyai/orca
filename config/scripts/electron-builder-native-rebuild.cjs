const { execFileSync } = require('node:child_process')
const { resolve } = require('node:path')

const projectDir = resolve(__dirname, '../..')

function electronBuilderNativeRebuild(context) {
  return runElectronBuilderNativeRebuild(context)
}

function runElectronBuilderNativeRebuild(context, runner = execFileSync) {
  const args = buildNativeRebuildArgs(context)
  runner(process.execPath, args, {
    cwd: projectDir,
    stdio: 'inherit'
  })

  // Why: returning false tells electron-builder that native deps were handled
  // externally, avoiding its all-module rebuild of optional cpu-features.
  return false
}

function buildNativeRebuildArgs(context) {
  const platform = readPlatformName(context?.platform)
  const arch = readArchName(context?.arch)

  return [
    'config/scripts/rebuild-native-deps.mjs',
    `--platform=${platform}`,
    `--arch=${arch}`,
    '--force'
  ]
}

function readPlatformName(platform) {
  const name = typeof platform === 'string' ? platform : platform?.nodeName
  if (!name) {
    throw new Error('electron-builder native rebuild context is missing platform.nodeName')
  }
  return name
}

function readArchName(arch) {
  if (!arch || typeof arch !== 'string') {
    throw new Error('electron-builder native rebuild context is missing arch')
  }
  return arch
}

module.exports = electronBuilderNativeRebuild
module.exports.default = electronBuilderNativeRebuild
module.exports.buildNativeRebuildArgs = buildNativeRebuildArgs
module.exports.runElectronBuilderNativeRebuild = runElectronBuilderNativeRebuild
