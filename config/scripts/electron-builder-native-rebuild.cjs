const { execFileSync } = require('node:child_process')
const { resolve } = require('node:path')
const { validateWindowsPackageArchitecture } = require('../windows-package-architecture.cjs')

const projectDir = resolve(__dirname, '../..')

function electronBuilderNativeRebuild(context) {
  return runElectronBuilderNativeRebuild(context)
}

function runElectronBuilderNativeRebuild(context, runner = execFileSync, runtime = {}) {
  const platform = readPlatformName(context?.platform)
  const arch = readArchName(context?.arch)
  validateWindowsPackageArchitecture(platform, arch, runtime.environment ?? process.env)
  if (platform === 'win32') {
    runner(process.execPath, ['config/scripts/build-windows-cli-launcher.mjs'], {
      cwd: projectDir,
      stdio: 'inherit'
    })
  }
  if (shouldStageWindowsNodePtyPrebuild(platform, arch)) {
    runner(
      process.execPath,
      ['config/scripts/stage-windows-node-pty-prebuild.mjs', `--arch=${arch}`],
      {
        cwd: projectDir,
        stdio: 'inherit'
      }
    )
    return false
  }
  const args = buildNativeRebuildArgs(context, runtime)
  runner(process.execPath, args, {
    cwd: projectDir,
    stdio: 'inherit'
  })

  // Why: returning false tells electron-builder that native deps were handled
  // externally, avoiding its all-module rebuild of optional cpu-features.
  return false
}

function shouldStageWindowsNodePtyPrebuild(platform, arch) {
  // Why: the verified prebuild avoids requiring an ARM64 MSVC toolchain.
  return platform === 'win32' && arch === 'arm64'
}

function buildNativeRebuildArgs(
  context,
  { environment = process.env, hostPlatform = process.platform, hostArch = process.arch } = {}
) {
  const platform = readPlatformName(context?.platform)
  const arch = readArchName(context?.arch)
  const canReusePreparedRuntime =
    environment.ORCA_REUSE_PREPARED_NATIVE_RUNTIME === '1' &&
    platform === hostPlatform &&
    arch === hostArch

  return [
    'config/scripts/rebuild-native-deps.mjs',
    `--platform=${platform}`,
    `--arch=${arch}`,
    ...(canReusePreparedRuntime ? [] : ['--force'])
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
module.exports.shouldStageWindowsNodePtyPrebuild = shouldStageWindowsNodePtyPrebuild
