import { getBrowserExtensionProfileIdForSession } from '../api-runtime/browser-extension-api-host'
import { browserExtensionHostPatterns } from './browser-extension-permission-grants'
import { getBrowserExtensionProfileStateStore } from '../profile-storage/browser-extension-profile-state-store'

export function readBrowserExtensionProfileGrants(profileId: string, extensionId: string) {
  return getBrowserExtensionProfileStateStore().read(profileId, extensionId)
}

/** Manifest host patterns plus origins the user granted in this session's profile. */
export function browserExtensionHostPatternsInSession(
  extension: Electron.Extension,
  session: Electron.Session
): string[] {
  const profileId = getBrowserExtensionProfileIdForSession(session)
  const grants = profileId
    ? readBrowserExtensionProfileGrants(profileId, extension.id)
    : { grantedPermissions: [], grantedOrigins: [] }
  return browserExtensionHostPatterns(extension.manifest, grants)
}
