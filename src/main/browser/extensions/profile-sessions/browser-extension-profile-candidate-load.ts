import type { InstalledBrowserExtension } from '../../../../shared/browser/extensions/browser-extension-types'
import { getBrowserExtensionInstallStore } from '../installation/browser-extension-install-store'
import { refreshBrowserExtensionPackage } from '../installation/browser-extension-load-directory'
import { admitBrowserExtensionTargetReplacement } from './browser-extension-profile-demand'
import {
  stateByProfileId,
  completeBrowserExtensionProfileLoad
} from './browser-extension-profile-session-state'
import {
  BROWSER_EXTENSION_PROFILE_UNAVAILABLE,
  throwIfBrowserExtensionAuthorityRevoked,
  throwIfBrowserExtensionLoadCancelled,
  type BrowserExtensionLoadAuthority
} from './browser-extension-profile-loads'
import { loadBrowserExtensionIntoSession } from './browser-extension-session-load'
import { unloadBrowserExtensionFromProfile } from './browser-extension-session-loader'

/**
 * Developer "Load unpacked": runs the chosen folder's copy whether a same-id predecessor is loaded,
 * cold or missing, and commits it only after that copy's own load under a still-current admission.
 */
export async function loadBrowserExtensionCandidateIntoProfile(
  profileId: string,
  candidate: InstalledBrowserExtension,
  admission: BrowserExtensionLoadAuthority,
  options: { replaces: boolean; refresh: boolean },
  commit: (loaded: Electron.Extension, record: InstalledBrowserExtension) => void
): Promise<Electron.Extension> {
  const state = stateByProfileId.get(profileId)
  if (!state) {
    throw new Error(BROWSER_EXTENSION_PROFILE_UNAVAILABLE)
  }
  if (options.refresh) {
    // Why before the predecessor stops: a refused folder leaves the running copy alone.
    await refreshBrowserExtensionPackage(candidate)
    throwIfBrowserExtensionAuthorityRevoked(admission)
  }
  // Why first: pages and nested operations wait for this candidate, never activate the old record.
  const replacement = admitBrowserExtensionTargetReplacement(profileId, candidate.id, true)
  if (!replacement || stateByProfileId.get(profileId) !== state) {
    replacement?.revoke()
    throw new Error(BROWSER_EXTENSION_PROFILE_UNAVAILABLE)
  }
  const reservation = getBrowserExtensionInstallStore().reserve(candidate)
  try {
    const unloaded = options.replaces
      ? unloadBrowserExtensionFromProfile(profileId, candidate.id, replacement)
      : Promise.resolve()
    void unloaded.catch(() => {})
    return await replacement.settle(
      state.loads.track(candidate.id, async (load) => {
        await unloaded
        throwIfBrowserExtensionLoadCancelled(load)
        throwIfBrowserExtensionAuthorityRevoked(admission)
        // Only an unreplaced same-folder copy can still be loaded here; it is the chosen package.
        let loaded = state.session.extensions.getExtension(candidate.id)
        if (!loaded) {
          loaded = await loadBrowserExtensionIntoSession(
            state.session,
            profileId,
            reservation.record,
            'other',
            load
          )
          await completeBrowserExtensionProfileLoad(state, loaded, load)
        }
        throwIfBrowserExtensionLoadCancelled(load)
        throwIfBrowserExtensionAuthorityRevoked(admission)
        commit(loaded, reservation.record)
        return loaded
      })
    )
  } catch (error) {
    replacement.revoke()
    throw error
  } finally {
    reservation.release()
  }
}
