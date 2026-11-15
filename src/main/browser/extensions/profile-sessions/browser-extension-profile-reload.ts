import type { InstalledBrowserExtension } from '../../../../shared/browser/extensions/browser-extension-types'
import { browserSessionRegistry } from '../../sessions/profiles/browser-session-registry'
import { refreshBrowserExtensionPackage } from '../installation/browser-extension-load-directory'
import { admitBrowserExtensionTargetReplacement } from './browser-extension-profile-demand'
import {
  hasBrowserExtensionProfileDemand,
  loadBrowserExtensionIntoProfile,
  replaceBrowserExtensionInProfile,
  unloadBrowserExtensionFromProfile
} from './browser-extension-session-loader'

function isEnabledIn(profileId: string, extensionId: string): boolean {
  return browserSessionRegistry.getEnabledExtensionIds(profileId).includes(extensionId)
}

/**
 * Swaps the loaded copy in every attached profile that has the extension turned on. Unloads all
 * first so re-copying an unpacked folder never rewrites files another profile is running.
 * A demanded target's pages wait for its replacement; cold profiles stay cold.
 */
export async function reloadBrowserExtensionWhereEnabled(
  extension: InstalledBrowserExtension,
  options: { refresh?: boolean; exceptProfileId?: string } = {}
): Promise<void> {
  const profileIds = browserSessionRegistry
    .listProfiles()
    .map((profile) => profile.id)
    .filter(
      (profileId) => profileId !== options.exceptProfileId && isEnabledIn(profileId, extension.id)
    )
  // Why before unloading: a staged first document must not proceed on the cancelled predecessor.
  const replacements = new Map(
    profileIds.map((profileId) => [
      profileId,
      admitBrowserExtensionTargetReplacement(profileId, extension.id, false)
    ])
  )
  try {
    await Promise.all(
      profileIds.map((profileId) =>
        unloadBrowserExtensionFromProfile(
          profileId,
          extension.id,
          replacements.get(profileId) ?? undefined
        )
      )
    )
    if (options.refresh) {
      await refreshBrowserExtensionPackage(extension)
    }
    for (const profileId of profileIds) {
      const replacement = replacements.get(profileId)
      // Why recheck: a Disable, teardown or last close during an earlier await revoked it.
      if (
        !isEnabledIn(profileId, extension.id) ||
        (replacement ? !replacement.current : !hasBrowserExtensionProfileDemand(profileId))
      ) {
        continue
      }
      await (
        replacement
          ? replaceBrowserExtensionInProfile(profileId, extension, replacement)
          : loadBrowserExtensionIntoProfile(profileId, extension, 'reload')
      ).catch((error) => {
        // A Disable that cancelled this load is not a reload failure; other profiles still reload.
        if (isEnabledIn(profileId, extension.id)) {
          throw error
        }
      })
    }
  } finally {
    for (const replacement of replacements.values()) {
      replacement?.revoke()
    }
  }
}
