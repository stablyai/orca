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
  type BrowserExtensionLoadAuthority,
  type BrowserExtensionProfileLoad
} from './browser-extension-profile-loads'
import { loadBrowserExtensionIntoSession } from './browser-extension-session-load'
import { trackInstalledBrowserExtensionLoad } from './browser-extension-profile-loading'
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
  const restores = options.replaces && Boolean(state.session.extensions.getExtension(candidate.id))
  let attempt: BrowserExtensionProfileLoad | undefined
  let rejected: { error: unknown } | undefined
  // Disable, removal, a successor or teardown owns the slot instead of the saved copy.
  const restoring = {
    get current() {
      return (
        !attempt?.cancelled &&
        admission.current &&
        replacement.current &&
        stateByProfileId.get(profileId) === state
      )
    }
  }
  try {
    const unloaded = options.replaces
      ? unloadBrowserExtensionFromProfile(profileId, candidate.id, replacement)
      : Promise.resolve()
    void unloaded.catch(() => {})
    const loading = state.loads.track(candidate.id, async (load) => {
      attempt = load
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
    // Why: like Chrome's Load unpacked, a rejected folder leaves the running copy running. Orca
    // already unloaded it, so the gate follows the saved copy's restore for waiting pages.
    const loaded = await replacement.settle(
      loading.catch((error: unknown) => {
        rejected = { error }
        // Why first: the saved copy loads under its own precedence, not the rejected candidate's.
        reservation.release()
        const saved = getBrowserExtensionInstallStore().get(candidate.id)
        // A loaded copy here is the candidate whose commit failed, not a predecessor to restore.
        const loaded = state.session.extensions.getExtension(candidate.id)
        if (!restores || !saved || loaded || !restoring.current) {
          throw error
        }
        // A failed restore records its own load error for Settings.
        return trackInstalledBrowserExtensionLoad(state, saved, 'other', restoring)
      })
    )
    if (rejected) {
      throw rejected.error
    }
    return loaded
  } catch (error) {
    replacement.revoke()
    throw rejected ? rejected.error : error
  } finally {
    reservation.release()
  }
}
