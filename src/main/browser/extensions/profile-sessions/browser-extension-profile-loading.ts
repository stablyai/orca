import { fireRuntimeLifecycleEvents } from './browser-extension-runtime-lifecycle'
import type { InstalledBrowserExtension } from '../../../../shared/browser/extensions/browser-extension-types'
import {
  acquireBrowserExtensionProfileDemand,
  trackBrowserExtensionTargetReadiness
} from './browser-extension-profile-demand'
import {
  completeBrowserExtensionProfileLoad,
  stateByProfileId
} from './browser-extension-profile-session-state'
import { BROWSER_EXTENSION_PROFILE_UNAVAILABLE } from './browser-extension-profile-loads'
import {
  loadInstalledBrowserExtensionIntoSession,
  loadBrowserExtensionIntoSession
} from './browser-extension-session-load'
import type { BrowserExtensionLoadKind } from './browser-extension-runtime-lifecycle'

export async function withBrowserExtensionProfileOperation<T>(
  profileId: string,
  extensionId: string,
  run: (sess: Electron.Session) => Promise<T>
): Promise<T> {
  const state = stateByProfileId.get(profileId)
  const owner = state && acquireBrowserExtensionProfileDemand(profileId, extensionId)
  if (!state || !owner) {
    throw new Error(BROWSER_EXTENSION_PROFILE_UNAVAILABLE)
  }
  try {
    await owner.ready
    return await run(state.session)
  } finally {
    await owner.release()
  }
}

export async function loadBrowserExtensionIntoProfile(
  profileId: string,
  extension: InstalledBrowserExtension,
  kind: BrowserExtensionLoadKind = 'other'
): Promise<Electron.Extension> {
  const state = stateByProfileId.get(profileId)
  if (!state) {
    throw new Error(BROWSER_EXTENSION_PROFILE_UNAVAILABLE)
  }
  return withBrowserExtensionProfileOperation(profileId, extension.id, () =>
    publishLoad(
      profileId,
      extension.id,
      state.loads.track(extension.id, async (load) => {
        const known = state.session.extensions.getExtension(extension.id)
        if (known) {
          if (kind === 'reload') {
            fireRuntimeLifecycleEvents(state.session, profileId, known, kind)
          }
          return known
        }
        const loaded = await loadInstalledBrowserExtensionIntoSession(
          state.session,
          profileId,
          extension,
          kind,
          load
        )
        await completeBrowserExtensionProfileLoad(state, loaded, load)
        return loaded
      })
    )
  )
}

/**
 * Developer "Load unpacked": loads Orca's copy of the folder, whose key gives it `extensionId`.
 * `refresh` copies the folder again, so pass it only when no profile can be running the copy.
 */
export async function loadBrowserExtensionFolderIntoProfile(
  profileId: string,
  extensionId: string,
  directory: string,
  options: { refresh: boolean }
): Promise<Electron.Extension> {
  const state = stateByProfileId.get(profileId)
  if (!state) {
    throw new Error(BROWSER_EXTENSION_PROFILE_UNAVAILABLE)
  }
  return withBrowserExtensionProfileOperation(profileId, extensionId, () =>
    publishLoad(
      profileId,
      extensionId,
      state.loads.track(extensionId, async (load) => {
        const known = state.session.extensions.getExtension(extensionId)
        if (known) {
          return known
        }
        const loaded = await loadBrowserExtensionIntoSession(
          state.session,
          profileId,
          { id: extensionId, source: 'unpacked', path: directory },
          'other',
          load,
          options
        )
        await completeBrowserExtensionProfileLoad(state, loaded, load)
        return loaded
      })
    )
  )
}

function publishLoad<T>(profileId: string, extensionId: string, ready: Promise<T>): Promise<T> {
  trackBrowserExtensionTargetReadiness(profileId, extensionId, ready)
  return ready
}
