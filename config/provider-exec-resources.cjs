const { spawnSync } = require('node:child_process')
const { chmodSync, existsSync, lstatSync } = require('node:fs')
const { join } = require('node:path')

const PROVIDER_EXEC_EXECUTABLE = 'orca-provider-exec'

// electron-builder `Arch` enum: x64=1, arm64=3. POSIX provider CLIs cannot launch without it.
function providerExecTarget(platform, archEnum) {
  const arch = { 1: 'x64', 3: 'arm64' }[archEnum]
  if (!arch || (platform !== 'darwin' && platform !== 'linux')) {
    throw new Error(`Unsupported provider exec packaging target: ${platform} ${archEnum}`)
  }
  return `${platform}-${arch}`
}

function ensureBundledProviderExec(
  platform,
  archEnum,
  root = join(__dirname, '..'),
  run = spawnSync
) {
  const target = providerExecTarget(platform, archEnum)
  const result = run(
    process.execPath,
    [
      join(root, 'config', 'scripts', 'native-build', 'posix', 'build-provider-exec.mjs'),
      '--target',
      target
    ],
    { cwd: root, stdio: 'inherit' }
  )
  if (
    result.error ||
    result.status !== 0 ||
    !existsSync(join(root, 'native', 'provider-exec', '.build', target, PROVIDER_EXEC_EXECUTABLE))
  ) {
    throw new Error(`The ${target} package requires a built provider exec helper.`)
  }
}

/** Packaged path the main process resolves; macOS keeps it beside the app executable. */
function packagedProviderExecPath(resourcesDir, platform) {
  return platform === 'darwin'
    ? join(resourcesDir, '..', 'MacOS', PROVIDER_EXEC_EXECUTABLE)
    : join(resourcesDir, 'bin', PROVIDER_EXEC_EXECUTABLE)
}

function finalizePackagedProviderExec(resourcesDir, platform) {
  const helper = packagedProviderExecPath(resourcesDir, platform)
  if (!existsSync(helper) || !lstatSync(helper).isFile()) {
    throw new Error(`The ${platform} package is missing its provider exec helper at ${helper}.`)
  }
  chmodSync(helper, 0o755)
  return helper
}

module.exports = { ensureBundledProviderExec, finalizePackagedProviderExec }
