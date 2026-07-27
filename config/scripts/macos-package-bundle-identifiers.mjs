export const MACOS_RELEASE_APP_BUNDLE_ID = 'com.stablyai.orca'
export const MACOS_LOCAL_APP_BUNDLE_ID = 'com.stablyai.orca.local'

function nonBlankBundleId(value) {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

export function resolveMacosPackageBundleIdentifiers(env = process.env) {
  const appBundleId =
    env.ORCA_MAC_RELEASE === '1' ? MACOS_RELEASE_APP_BUNDLE_ID : MACOS_LOCAL_APP_BUNDLE_ID
  return {
    appBundleId,
    computerUseBundleId: `${appBundleId}.computer-use`
  }
}

export function resolveMacosComputerUseBundleId(env = process.env) {
  return (
    nonBlankBundleId(env.ORCA_COMPUTER_MACOS_BUNDLE_ID) ??
    resolveMacosPackageBundleIdentifiers(env).computerUseBundleId
  )
}

export function resolveMacosNotificationStatusBundleId(explicitBundleId, env = process.env) {
  return nonBlankBundleId(explicitBundleId) ?? resolveMacosPackageBundleIdentifiers(env).appBundleId
}
