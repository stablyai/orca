import { session } from 'electron'
import { forgetBrowserExtensionActionProfile } from './browser-extension-action-registry'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserSessionProfile } from '../../../shared/browser-workspace-types'
import type { InstalledBrowserExtension } from '../../../shared/browser-extension-types'
import { isBrowserExtensionSupportEnabled } from './browser-extension-support'
import { getBrowserExtensionInstallStore } from './browser-extension-install-store'
import { getBrowserExtensionProfileStateStore } from './browser-extension-profile-state-store'
import { getBrowserExtensionSyncStorageStore } from './browser-extension-sync-storage-store'
import { getBrowserExtensionDnrStore } from './browser-extension-dnr-store'
import { retireBrowserExtensionProfileStorage } from './browser-extension-retired-profile-storage'
import {
  attachBrowserExtensionApiHostToSession,
  forgetBrowserExtensionContexts
} from './browser-extension-api-host'
import type { BrowserExtensionLoadKind } from './browser-extension-runtime-lifecycle'
import { removeUninstalledBrowserExtensionData } from './browser-extension-data-removal'
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
import {
  loadBrowserExtensionIntoSession,
  loadInstalledBrowserExtensionIntoSession
} from './browser-extension-session-load'

type ProfileSessionState = {
  profile: BrowserSessionProfile
  session: Electron.Session
  /** Startup's sweep and loads; later loads wait for it. */
  loading: Promise<void>
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
const PRELOAD_FILE_NAME = 'browser-extension-preload.js'
const PRELOAD_ID = 'orca-browser-extension-frame'
const preloadedSessions = new WeakSet<Electron.Session>()

function registerExtensionPreload(sess: Electron.Session): void {
  if (preloadedSessions.has(sess)) {
    return
  }
  // Why the parent too: this module can land in out/main/chunks, one level below the preload entry.
  const filePath = [
    join(__dirname, PRELOAD_FILE_NAME),
    join(__dirname, '..', PRELOAD_FILE_NAME)
  ].find((candidate) => existsSync(candidate))
  if (!filePath) {
    console.warn(
      '[browser-extensions] Extension preload is missing; extension APIs are unavailable'
    )
    return
  }
  // Why frame only: a service-worker preload crashes the renderer during GC (electron#52310).
  // Workers load Orca's API shim through the background wrapper instead.
  sess.registerPreloadScript({ id: PRELOAD_ID, type: 'frame', filePath })
  preloadedSessions.add(sess)
}

function unregisterExtensionPreload(sess: Electron.Session): void {
  if (preloadedSessions.delete(sess)) {
    sess.unregisterPreloadScript(PRELOAD_ID)
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
  const sess = session.fromPartition(profile.partition)
  registerExtensionPreload(sess)
  attachBrowserExtensionApiHostToSession(sess, profile.id)
  sessionHooks?.attached(sess, profile.id, enabledExtensionIds)
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
          'startup',
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
  void loading.catch(() => {})
  stateByProfileId.set(profile.id, { profile, session: sess, loading, loads })
}

/** Unloads a profile session's extensions and Orca's wiring; its saved extension data stays. */
async function unloadProfileSession(state: ProfileSessionState): Promise<void> {
  forgetBrowserExtensionLoadFailures({ profileId: state.profile.id })
  await Promise.all([state.loading.catch(() => {}), state.loads.close()])
  for (const extension of state.session.extensions.getAllExtensions()) {
    removeBrowserExtensionFromSession(state.session, extension.id)
  }
  forgetBrowserExtensionContexts(state.session)
  unregisterExtensionPreload(state.session)
  sessionHooks?.detached(state.session)
}

/** Profile delete clears saved extension data before unloading, even if never attached. */
export async function detachBrowserExtensionsFromProfileSession(
  profile: BrowserSessionProfile
): Promise<void> {
  const state = stateByProfileId.get(profile.id)
  const sess = state?.session ?? session.fromPartition(profile.partition)
  if (state) {
    stateByProfileId.delete(profile.id)
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
    forgetBrowserExtensionActionProfile(profile.id)
  }
  getBrowserExtensionProfileStateStore().forgetProfile(profile.id)
  getBrowserExtensionSyncStorageStore().forgetProfile(profile.id)
  getBrowserExtensionDnrStore().forgetProfile(profile.id)
}

/** The experimental setting turned off: every profile drops its extensions until it turns on. */
export async function detachBrowserExtensionsFromAllProfileSessions(): Promise<void> {
  const states = [...stateByProfileId.values()]
  stateByProfileId.clear()
  await Promise.all(states.map(unloadProfileSession))
}

/** One profile session's startup loads, restore hooks included. */
export function whenBrowserExtensionProfileLoaded(profileId: string): Promise<void> {
  return stateByProfileId.get(profileId)?.loading.catch(() => {}) ?? Promise.resolve()
}

/** Startup waits briefly so restored tabs get content scripts; a slow load never blocks launch. */
export async function whenBrowserExtensionSessionsLoaded(timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    Promise.all([...stateByProfileId.values()].map((state) => state.loading.catch(() => {}))),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
  ])
  clearTimeout(timer)
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
  for (const state of stateByProfileId.values()) {
    if (state.profile.partition === partition) {
      return state.profile
    }
  }
  return null
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
