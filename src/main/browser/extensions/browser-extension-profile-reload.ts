import type { InstalledBrowserExtension } from '../../../shared/browser-extension-types'
import { browserSessionRegistry } from '../browser-session-registry'
import { prepareBrowserExtensionDirectory } from './browser-extension-load-directory'
import {
  getBrowserExtensionSessionForProfile,
  loadBrowserExtensionIntoProfile,
  unloadBrowserExtensionFromProfile
} from './browser-extension-session-loader'

function isEnabledIn(profileId: string, extensionId: string): boolean {
  return browserSessionRegistry.getEnabledExtensionIds(profileId).includes(extensionId)
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
    if (!isEnabledIn(profileId, extension.id)) {
      continue
    }
    await loadBrowserExtensionIntoProfile(profileId, extension, 'reload').catch((error) => {
      // A Disable that cancelled this load is not a reload failure; other profiles still reload.
      if (isEnabledIn(profileId, extension.id)) {
        throw error
      }
    })
  }
}
