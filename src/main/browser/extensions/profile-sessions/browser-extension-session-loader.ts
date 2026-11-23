import { session } from 'electron'
import { holdBrowserSessionRequestGate } from '../../sessions/requests/browser-session-request-gate'
import { forgetBrowserExtensionActionProfile } from '../actions/browser-extension-action-registry'
import {
  registerBrowserSessionFramePreload,
  unregisterBrowserSessionFramePreload
} from '../../sessions/browser-session-frame-preloads'
import type { BrowserSessionProfile } from '../../../../shared/browser/workspaces/browser-workspace-types'
import type { InstalledBrowserExtension } from '../../../../shared/browser/extensions/browser-extension-types'
import { isBrowserExtensionSupportEnabled } from '../browser-extension-support'
import { getBrowserExtensionInstallStore } from '../installation/browser-extension-install-store'
import { getBrowserExtensionProfileStateStore } from '../profile-storage/browser-extension-profile-state-store'
import { getBrowserExtensionSyncStorageStore } from '../profile-storage/browser-extension-sync-storage-store'
import { getBrowserExtensionDnrStore } from '../declarative-net-request/session/browser-extension-dnr-store'
import { retireBrowserExtensionProfileStorage } from '../profile-storage/browser-extension-retired-profile-storage'
import {
  attachBrowserExtensionApiHostToSession,
  forgetBrowserExtensionContexts
} from '../api-runtime/browser-extension-api-host'
import type { BrowserExtensionLoadKind } from './browser-extension-runtime-lifecycle'
import { removeUninstalledBrowserExtensionData } from '../profile-storage/browser-extension-data-removal'
import {
  clearBrowserExtensionLoadFailure,
  forgetBrowserExtensionLoadFailures
} from './browser-extension-load-errors'
import {
  BROWSER_EXTENSION_PROFILE_UNAVAILABLE,
  BrowserExtensionProfileLoads,
  throwIfBrowserExtensionLoadCancelled
} from './browser-extension-profile-loads'
import { removeBrowserExtensionFromSession } from './browser-extension-worker-registration'
import * as idleKeptState from './browser-extension-idle-kept-state'
import {
  loadBrowserExtensionIntoSession,
  loadInstalledBrowserExtensionIntoSession
} from './browser-extension-session-load'

type ProfileSessionState = {
  profile: BrowserSessionProfile
  session: Electron.Session
  /** The attach's sweep and loads; later loads wait for it. */
  loading: Promise<void>
  /** Until `loading` settles, when the attach had extensions to load. */
  loadingExtensions: boolean
  loads: BrowserExtensionProfileLoads
}

/** Per-session services and per-extension restart restore, supplied by browser-extension-startup. */
export type BrowserExtensionSessionHooks = {
  attached: (sess: Electron.Session, profileId: string, enabledExtensionIds: string[]) => void
  /** Runs after each startup load; resolves when restored state is back in place. */
  loaded: (
    sess: Electron.Session,
    profileId: string,
    extension: Electron.Extension
  ) => Promise<void>
  /** Extensions turned off: undo what `attached` added to the request path. */
  detached: (sess: Electron.Session) => void
  uninstalled: (profileId: string, extensionIds: ReadonlySet<string>) => void
}

let sessionHooks: BrowserExtensionSessionHooks | null = null

export function setBrowserExtensionSessionHooks(hooks: BrowserExtensionSessionHooks): void {
  sessionHooks = hooks
}

const stateByProfileId = new Map<string, ProfileSessionState>()
/** Attached profiles by partition, so a page's partition finds its profile without a scan. */
const profileIdByPartition = new Map<string, string>()
/** Profiles whose last page closed and whose extensions are unloading; done once reattach settles. */
const unloadingByProfileId = new Map<string, Promise<void>>()
const reattachRequestedProfileIds = new Set<string>()
const PRELOAD_FILE_NAME = 'browser-extension-preload.js'
const PRELOAD_ID = 'orca-browser-extension-frame'

// Workers load Orca's API shim from their own script instead.
function registerExtensionPreload(sess: Electron.Session): void {
  if (!registerBrowserSessionFramePreload(sess, PRELOAD_ID, PRELOAD_FILE_NAME)) {
    console.warn(
      '[browser-extensions] Extension preload is missing; extension APIs are unavailable'
    )
  }
}

/** Session setup hook for a local browser profile: wire the host, register the preload, load what's enabled. */
export function attachBrowserExtensionsToProfileSession(
  profile: BrowserSessionProfile,
  enabledExtensionIds: string[]
): void {
  if (!isBrowserExtensionSupportEnabled() || stateByProfileId.has(profile.id)) {
    return
  }
  // Loading into a session still being unloaded would be undone by it; reattach once it is done.
  if (unloadingByProfileId.has(profile.id)) {
    reattachRequestedProfileIds.add(profile.id)
    return
  }
  const sess = session.fromPartition(profile.partition)
  registerExtensionPreload(sess)
  attachBrowserExtensionApiHostToSession(sess, profile.id)
  sessionHooks?.attached(sess, profile.id, enabledExtensionIds)
  const kindFor = idleKeptState.settleKeptStateOnAttach(profile.id, enabledExtensionIds)
  const store = getBrowserExtensionInstallStore()
  const loads = new BrowserExtensionProfileLoads()
  const swept = removeUninstalledBrowserExtensionData(
    sess,
    profile.id,
    new Set(store.list().map((extension) => extension.id)),
    (stale) => sessionHooks?.uninstalled(profile.id, stale)
  )
  const startupLoads = enabledExtensionIds.map((extensionId) =>
    loads
      .track(extensionId, async (load) => {
        const stale = await swept
        const installed = store.get(extensionId)
        throwIfBrowserExtensionLoadCancelled(load)
        if (!installed || stale.has(extensionId)) {
          return
        }
        const loaded = await loadInstalledBrowserExtensionIntoSession(
          sess,
          profile.id,
          installed,
          kindFor(extensionId),
          load
        )
        await sessionHooks?.loaded(sess, profile.id, loaded)
      })
      .catch((error: unknown) => {
        console.warn(`[browser-extensions] Failed to load ${extensionId}:`, error)
      })
  )
  const loading = Promise.all([swept, ...startupLoads])
    .then(() => undefined)
    .catch((error: unknown) => {
      console.warn('[browser-extensions] Could not initialize extension storage:', error)
      throw error
    })
  const state: ProfileSessionState = {
    profile,
    session: sess,
    loading,
    loadingExtensions: enabledExtensionIds.length > 0,
    loads
  }
  // The request gate listens only for loaded extensions; requests made while they load must still
  // reach their startup holds (rules, webRequest listeners).
  const releaseRequestGate = state.loadingExtensions ? holdBrowserSessionRequestGate(sess) : null
  void loading
    .catch(() => {})
    .finally(() => {
      releaseRequestGate?.()
      state.loadingExtensions = false
      idleKeptState.dropUnclaimedBrowserExtensionIdleState(profile.id)
    })
  stateByProfileId.set(profile.id, state)
  profileIdByPartition.set(profile.partition, profile.id)
}

/** Unloads a profile session's extensions and Orca's wiring; its saved extension data stays. */
async function unloadProfileSession(state: ProfileSessionState): Promise<void> {
  forgetBrowserExtensionLoadFailures({ profileId: state.profile.id })
  await Promise.all([state.loading.catch(() => {}), state.loads.close()])
  for (const extension of state.session.extensions.getAllExtensions()) {
    removeBrowserExtensionFromSession(state.session, extension.id)
  }
  forgetBrowserExtensionContexts(state.session)
  unregisterBrowserSessionFramePreload(state.session, PRELOAD_ID)
  sessionHooks?.detached(state.session)
}

/** Profile delete clears saved extension data before unloading, even if never attached. */
export async function detachBrowserExtensionsFromProfileSession(
  profile: BrowserSessionProfile
): Promise<void> {
  // An idle unload still removing extensions must finish before storage is retired.
  await unloadingByProfileId.get(profile.id)
  const state = stateByProfileId.get(profile.id)
  const sess = state?.session ?? session.fromPartition(profile.partition)
  if (state) {
    stateByProfileId.delete(profile.id)
    profileIdByPartition.delete(profile.partition)
    forgetBrowserExtensionContexts(sess)
    await Promise.all([state.loading.catch(() => {}), state.loads.close()])
  }
  await retireBrowserExtensionProfileStorage(sess, profile.partition).catch((error: unknown) => {
    console.warn('[browser-extensions] Could not clear deleted profile storage:', error)
  })
  try {
    if (state) {
      await unloadProfileSession(state)
    }
  } finally {
    idleKeptState.dropBrowserExtensionIdleState({ profileId: profile.id, forgetProfile: true })
    forgetBrowserExtensionActionProfile(profile.id)
    getBrowserExtensionProfileStateStore().forgetProfile(profile.id)
    await Promise.all([
      getBrowserExtensionSyncStorageStore().forgetProfile(profile.id),
      getBrowserExtensionDnrStore().forgetProfile(profile.id)
    ])
  }
}

/** The extensions setting turned off: every profile drops its extensions until it turns on. */
export async function detachBrowserExtensionsFromAllProfileSessions(): Promise<void> {
  const states = [...stateByProfileId.values()]
  const idleUnloads = [...unloadingByProfileId.values()]
  stateByProfileId.clear()
  profileIdByPartition.clear()
  await Promise.all([...states.map(unloadProfileSession), ...idleUnloads])
}

/**
 * A profile with no pages left stops its extensions, as closing a profile's last window does in
 * Chromium; its saved extension data and session state stay. `afterUnload` runs before waiters resume, with whether
 * an attach asked for the profile meanwhile, so it can reattach.
 */
export async function unloadBrowserExtensionsFromIdleProfile(
  profileId: string,
  afterUnload: (reattachRequested: boolean) => void
): Promise<void> {
  const state = stateByProfileId.get(profileId)
  if (!state || unloadingByProfileId.has(profileId)) {
    return
  }
  stateByProfileId.delete(profileId)
  profileIdByPartition.delete(state.profile.partition)
  idleKeptState.beginIdleUnload(profileId, state.session)
  const unloading = unloadProfileSession(state)
    .catch((error: unknown) => {
      console.warn("[browser-extensions] Could not stop an idle profile's extensions:", error)
    })
    .then(() => {
      unloadingByProfileId.delete(profileId)
      try {
        afterUnload(reattachRequestedProfileIds.delete(profileId))
      } catch (error) {
        console.warn("[browser-extensions] Could not restart a profile's extensions:", error)
      }
    })
  unloadingByProfileId.set(profileId, unloading)
  await unloading
}

/** Resolves once an idle unload of this profile, and the reattach it may run, are done. */
export function whenBrowserExtensionProfileUnloaded(profileId: string): Promise<void> {
  return unloadingByProfileId.get(profileId) ?? Promise.resolve()
}

/** One profile session's attach-time loads, restore hooks included. */
export function whenBrowserExtensionProfileLoaded(profileId: string): Promise<void> {
  const unloading = unloadingByProfileId.get(profileId)
  if (unloading) {
    return unloading.then(() => whenBrowserExtensionProfileLoaded(profileId))
  }
  return stateByProfileId.get(profileId)?.loading.catch(() => {}) ?? Promise.resolve()
}

/** Whether the profile's enabled extensions are still loading after its attach. */
export function isBrowserExtensionProfileLoading(profileId: string): boolean {
  return (
    unloadingByProfileId.has(profileId) ||
    (stateByProfileId.get(profileId)?.loadingExtensions ?? false)
  )
}

export function getBrowserExtensionSessionForProfile(profileId: string): Electron.Session | null {
  return stateByProfileId.get(profileId)?.session ?? null
}

/** Every local profile session extensions run in this launch. */
export function listBrowserExtensionSessions(): Electron.Session[] {
  return [...stateByProfileId.values()].map((state) => state.session)
}

export function getBrowserExtensionProfile(profileId: string): BrowserSessionProfile | null {
  return stateByProfileId.get(profileId)?.profile ?? null
}

export function getBrowserExtensionProfileForPartition(
  partition: string
): BrowserSessionProfile | null {
  const profileId = profileIdByPartition.get(partition)
  return profileId ? (stateByProfileId.get(profileId)?.profile ?? null) : null
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
  return state.loads.track(extension.id, async (load) => {
    await state.loading
    return loadInstalledBrowserExtensionIntoSession(state.session, profileId, extension, kind, load)
  })
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
  return state.loads.track(extensionId, async (load) => {
    await state.loading
    return loadBrowserExtensionIntoSession(
      state.session,
      profileId,
      { id: extensionId, source: 'unpacked', path: directory },
      'other',
      load,
      options
    )
  })
}

/** Unloads it and cancels its loads in flight, which stop at their next step. */
export function unloadBrowserExtensionFromProfile(profileId: string, extensionId: string): void {
  void unloadAndCancel(profileId, extensionId)
}

function unloadAndCancel(profileId: string, extensionId: string): Promise<unknown> {
  clearBrowserExtensionLoadFailure(profileId, extensionId)
  const state = stateByProfileId.get(profileId)
  if (!state) {
    return Promise.resolve()
  }
  const stopped = state.loads.cancel(extensionId)
  if (state.session.extensions.getExtension(extensionId)) {
    removeBrowserExtensionFromSession(state.session, extensionId)
  }
  return stopped
}

/** Resolves once its cancelled loads have stopped, so removal can purge what they wrote. */
export async function unloadBrowserExtensionEverywhere(extensionId: string): Promise<void> {
  await Promise.all(
    [...stateByProfileId.keys()].map((profileId) => unloadAndCancel(profileId, extensionId))
  )
}
