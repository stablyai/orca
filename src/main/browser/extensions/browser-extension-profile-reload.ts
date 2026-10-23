import type { InstalledBrowserExtension } from '../../../shared/browser-extension-types'
import { browserSessionRegistry } from '../browser-session-registry'
import { prepareBrowserExtensionDirectory } from './browser-extension-load-directory'
import {
  getBrowserExtensionSessionForProfile,
  loadBrowserExtensionIntoProfile,
  unloadBrowserExtensionFromProfile
} from './browser-extension-session-loader'

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
        browserSessionRegistry.getEnabledExtensionIds(profileId).includes(extension.id) &&
        getBrowserExtensionSessionForProfile(profileId)
    )
  for (const profileId of profileIds) {
    unloadBrowserExtensionFromProfile(profileId, extension.id)
  }
  if (options.refresh) {
    await prepareBrowserExtensionDirectory(extension, { refresh: true })
  }
  for (const profileId of profileIds) {
    await loadBrowserExtensionIntoProfile(profileId, extension, 'reload')
  }
}
