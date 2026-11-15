import { fireRuntimeLifecycleEvents } from './browser-extension-runtime-lifecycle'
import type { InstalledBrowserExtension } from '../../../../shared/browser/extensions/browser-extension-types'
import {
  acquireBrowserExtensionProfileDemand,
  trackBrowserExtensionTargetReadiness
} from './browser-extension-profile-demand'
import {
  admitBrowserExtensionEnable,
  completeBrowserExtensionProfileLoad,
  stateByProfileId,
  type ProfileSessionState
} from './browser-extension-profile-session-state'
import {
  BROWSER_EXTENSION_PROFILE_UNAVAILABLE,
  throwIfBrowserExtensionAuthorityRevoked,
  throwIfBrowserExtensionLoadCancelled,
  type BrowserExtensionLoadAuthority
} from './browser-extension-profile-loads'
import { loadInstalledBrowserExtensionIntoSession } from './browser-extension-session-load'
import type { BrowserExtensionLoadKind } from './browser-extension-runtime-lifecycle'

export async function withBrowserExtensionProfileOperation<T>(
  profileId: string,
  extensionId: string,
  run: (sess: Electron.Session) => Promise<T>,
  authority?: BrowserExtensionLoadAuthority
): Promise<T> {
  const state = stateByProfileId.get(profileId)
  const owner = state && acquireBrowserExtensionProfileDemand(profileId, extensionId)
  if (!state || !owner) {
    throw new Error(BROWSER_EXTENSION_PROFILE_UNAVAILABLE)
  }
  try {
    await owner.ready
    throwIfBrowserExtensionAuthorityRevoked(authority)
    return await run(state.session)
  } finally {
    await owner.release()
  }
}

/** The tracked body for an installed record; a replacement producer calls it unguarded. */
export function trackInstalledBrowserExtensionLoad(
  state: ProfileSessionState,
  extension: InstalledBrowserExtension,
  kind: BrowserExtensionLoadKind,
  authority?: BrowserExtensionLoadAuthority
): Promise<Electron.Extension> {
  return state.loads.track(extension.id, async (load) => {
    throwIfBrowserExtensionLoadCancelled(load)
    throwIfBrowserExtensionAuthorityRevoked(authority)
    const known = state.session.extensions.getExtension(extension.id)
    if (known) {
      if (kind === 'reload') {
        fireRuntimeLifecycleEvents(state.session, state.profile.id, known, kind)
      }
      return known
    }
    const loaded = await loadInstalledBrowserExtensionIntoSession(
      state.session,
      state.profile.id,
      extension,
      kind,
      load
    )
    await completeBrowserExtensionProfileLoad(state, loaded, load)
    throwIfBrowserExtensionAuthorityRevoked(authority)
    return loaded
  })
}

export async function loadBrowserExtensionIntoProfile(
  profileId: string,
  extension: InstalledBrowserExtension,
  kind: BrowserExtensionLoadKind = 'other',
  authority?: BrowserExtensionLoadAuthority
): Promise<Electron.Extension> {
  const state = stateByProfileId.get(profileId)
  if (!state) {
    throw new Error(BROWSER_EXTENSION_PROFILE_UNAVAILABLE)
  }
  return withBrowserExtensionProfileOperation(
    profileId,
    extension.id,
    () =>
      publishLoad(
        profileId,
        extension.id,
        trackInstalledBrowserExtensionLoad(state, extension, kind, authority)
      ),
    authority
  )
}

/**
 * Loads an installed extension, then `commit` records it on. Pass earlier authority when the
 * caller awaited before loading; otherwise call right after taking the extension lock.
 */
export async function enableBrowserExtensionInProfile(
  profileId: string,
  extension: InstalledBrowserExtension,
  commit: () => void,
  authority?: BrowserExtensionLoadAuthority
): Promise<void> {
  const admission = authority ? undefined : admitBrowserExtensionEnable(profileId, extension.id)
  const enableAuthority = authority ?? admission
  try {
    throwIfBrowserExtensionAuthorityRevoked(enableAuthority)
    await withBrowserExtensionProfileOperation(
      profileId,
      extension.id,
      async () => {
        await loadBrowserExtensionIntoProfile(profileId, extension, 'other', enableAuthority)
        throwIfBrowserExtensionAuthorityRevoked(enableAuthority)
        commit()
      },
      enableAuthority
    )
  } finally {
    admission?.revoke()
  }
}

function publishLoad<T>(profileId: string, extensionId: string, ready: Promise<T>): Promise<T> {
  trackBrowserExtensionTargetReadiness(profileId, extensionId, ready)
  return ready
}
