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

function getWindowsSpeechNativePackage(architecture) {
  return architecture === 'arm64' ? null : 'sherpa-onnx-win-x64'
}

function createWindowsArchitectureResources(env = process.env) {
  const resources = []
  const speechPackage = getWindowsSpeechNativePackage(isWindowsArm64Build(env) ? 'arm64' : 'x64')
  if (speechPackage) {
    resources.push({
      from: `node_modules/${speechPackage}`,
      to: `node_modules/${speechPackage}`
    })
  }

  // Why: keep this filename aligned with getAgentBrowserBinaryName; upstream
  // uses its x64 executable under Windows on ARM emulation.
  resources.push({
    from: 'node_modules/agent-browser/bin/agent-browser-win32-x64.exe',
    to: 'agent-browser-win32-x64.exe'
  })
  return resources
}

// Why: shipped x64 clients pick installers by /windows-setup\.exe$/, so the arm64 name must not match it.
function getWindowsInstallerArtifactName(env = process.env) {
  return isWindowsArm64Build(env) ? 'orca-windows-setup-arm64.${ext}' : 'orca-windows-setup.${ext}'
}

// Why: electron-updater reads latest.yml on every Windows arch; arm64 installs need their own manifest.
function getWindowsUpdateChannelPublishOptions(env = process.env) {
  return isWindowsArm64Build(env) ? { channel: 'latest-arm64' } : {}
}

module.exports = {
  WINDOWS_ARM64_BUILD_ENV,
  createWindowsArchitectureResources,
  getWindowsInstallerArtifactName,
  getWindowsSpeechNativePackage,
  getWindowsUpdateChannelPublishOptions,
  isWindowsArm64Build,
  validateWindowsPackageArchitecture
}
