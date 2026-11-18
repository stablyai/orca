import type { InstalledBrowserExtension } from '../../../../shared/browser/extensions/browser-extension-types'
import { browserSessionRegistry } from '../../sessions/profiles/browser-session-registry'
import { prepareBrowserExtensionDirectory } from '../installation/browser-extension-load-directory'
import {
  getBrowserExtensionSessionForProfile,
  loadBrowserExtensionIntoProfile,
  unloadBrowserExtensionFromProfile
} from './browser-extension-session-loader'

function isEnabledIn(profileId: string, extensionId: string): boolean {
  return browserSessionRegistry.getEnabledExtensionIds(profileId).includes(extensionId)
}

/** Why attached too: a profile that went idle meanwhile loads the new copy when it reopens. */
function stillLoadsIn(profileId: string, extensionId: string): boolean {
  return (
    isEnabledIn(profileId, extensionId) && getBrowserExtensionSessionForProfile(profileId) !== null
  )
}

/**
 * Swaps the loaded copy in every attached profile that has the extension turned on. Unloads all
 * first so re-copying an unpacked folder never rewrites files another profile is running.
 */
export async function reloadBrowserExtensionWhereEnabled(
  extension: InstalledBrowserExtension,
  options: { refresh?: boolean } = {}
): Promise<void> {
  const profileIds = browserSessionRegistry
    .listProfiles()
    .map((profile) => profile.id)
    .filter(
      (profileId) =>
        isEnabledIn(profileId, extension.id) && getBrowserExtensionSessionForProfile(profileId)
    )
  for (const profileId of profileIds) {
    unloadBrowserExtensionFromProfile(profileId, extension.id)
  }
  if (options.refresh) {
    await prepareBrowserExtensionDirectory(extension, { refresh: true })
  }
  for (const profileId of profileIds) {
    // Why recheck: a Disable during an earlier await had no load of ours to cancel.
    if (!stillLoadsIn(profileId, extension.id)) {
      continue
    }
    await loadBrowserExtensionIntoProfile(profileId, extension, 'reload').catch((error) => {
      // A Disable or idle stop that cancelled this load is not a reload failure.
      if (stillLoadsIn(profileId, extension.id)) {
        throw error
      }
    })
  }
}
