import { browserSessionRegistry } from '../browser-session-registry'
import { withExtensionEnabled, withoutExtension } from './browser-extension-profile-enablement'

// Why cached: toolbars refetch on every badge change, and the registry reads its file each call.
const pinnedByProfileId = new Map<string, string[]>()

/** Pinned extension ids for one browser profile, in pin order; saved with the profile's metadata. */
export function getPinnedBrowserExtensionIds(profileId: string): string[] {
  let pinned = pinnedByProfileId.get(profileId)
  if (!pinned) {
    pinned = browserSessionRegistry.getPinnedExtensionIds(profileId)
    pinnedByProfileId.set(profileId, pinned)
  }
  return pinned
}

export function setBrowserExtensionPinned(
  profileId: string,
  extensionId: string,
  pinned: boolean
): void {
  // The per-profile id-set edits are the same ones the enabled lists use.
  browserSessionRegistry.updatePinnedExtensionIds((byProfile) =>
    withExtensionEnabled(byProfile, profileId, extensionId, pinned)
  )
  pinnedByProfileId.clear()
}

/** Removing an extension unpins it everywhere. */
export function forgetPinnedBrowserExtension(extensionId: string): void {
  browserSessionRegistry.updatePinnedExtensionIds((byProfile) =>
    withoutExtension(byProfile, extensionId)
  )
  pinnedByProfileId.clear()
}
