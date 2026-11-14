import type { InstalledBrowserExtension } from '../../../../shared/browser/extensions/browser-extension-types'
import { browserSessionRegistry } from '../../sessions/profiles/browser-session-registry'
import { refreshBrowserExtensionPackage } from '../installation/browser-extension-load-directory'
import {
  hasBrowserExtensionProfileDemand,
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
    .filter((profileId) => isEnabledIn(profileId, extension.id))
  await Promise.all(
    profileIds.map((profileId) => unloadBrowserExtensionFromProfile(profileId, extension.id))
  )
  if (options.refresh) {
    await refreshBrowserExtensionPackage(extension)
  }
  for (const profileId of profileIds) {
    // Why recheck: a Disable during an earlier await had no load of ours to cancel.
    if (!isEnabledIn(profileId, extension.id) || !hasBrowserExtensionProfileDemand(profileId)) {
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
