const WINDOWS_ARM64_BUILD_ENV = 'ORCA_WINDOWS_ARM64_BUILD'

function isWindowsArm64Build(env = process.env) {
  return env[WINDOWS_ARM64_BUILD_ENV] === '1'
}

function validateWindowsPackageArchitecture(platform, architecture, env = process.env) {
  if (platform !== 'win32') {
    return
  }
  const expectsArm64 = architecture === 'arm64'
  if (isWindowsArm64Build(env) !== expectsArm64) {
    throw new Error(
      `${WINDOWS_ARM64_BUILD_ENV} must be ${expectsArm64 ? '1' : 'unset'} ` +
        `for a Windows ${architecture} package`
    )
  }
}

function getWindowsInstallerArtifactName(env = process.env) {
  return isWindowsArm64Build(env) ? 'orca-windows-setup-arm64.${ext}' : 'orca-windows-setup.${ext}'
}

// Why: electron-updater reads latest.yml on every Windows arch; arm64 installs need their own manifest.
function getWindowsUpdateChannelPublishOptions(env = process.env) {
  return isWindowsArm64Build(env) ? { channel: 'latest-arm64' } : {}
}

module.exports = {
  WINDOWS_ARM64_BUILD_ENV,
  getWindowsInstallerArtifactName,
  getWindowsUpdateChannelPublishOptions,
  isWindowsArm64Build,
  validateWindowsPackageArchitecture
}
