import { session } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserSessionProfile } from '../../../shared/browser-workspace-types'
import type { InstalledBrowserExtension } from '../../../shared/browser-extension-types'
import { isBrowserExtensionSupportEnabled } from './browser-extension-support'
import { getBrowserExtensionInstallStore } from './browser-extension-install-store'
import { getBrowserExtensionProfileStateStore } from './browser-extension-profile-state-store'
import { getBrowserExtensionSyncStorageStore } from './browser-extension-sync-storage-store'
import { getBrowserExtensionDnrStore } from './browser-extension-dnr-store'
import {
  attachBrowserExtensionApiHostToSession,
  forgetBrowserExtensionContexts
} from './browser-extension-api-host'
import {
  fireRuntimeLifecycleEvents,
  type BrowserExtensionLoadKind
} from './browser-extension-runtime-lifecycle'
import { removeOrphanedBrowserExtensionStorage } from './browser-extension-data-removal'
import {
  clearBrowserExtensionLoadFailure,
  forgetBrowserExtensionLoadFailures,
  recordBrowserExtensionLoadFailure
} from './browser-extension-load-errors'
import {
  prepareBrowserExtensionDirectory,
  type BrowserExtensionLoadSource
} from './browser-extension-load-directory'
import {
  refreshWorkerRegistration,
  removeBrowserExtensionFromSession,
  whenWorkerRegistered
} from './browser-extension-worker-registration'

type ProfileSessionState = {
  profile: BrowserSessionProfile
  session: Electron.Session
  loading: Promise<void>
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
}

let sessionHooks: BrowserExtensionSessionHooks | null = null

export function setBrowserExtensionSessionHooks(hooks: BrowserExtensionSessionHooks): void {
  sessionHooks = hooks
}

const PRELOAD_FILE_NAME = 'browser-extension-preload.js'
const PRELOAD_ID = 'orca-browser-extension-frame'
const stateByProfileId = new Map<string, ProfileSessionState>()
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

async function loadIntoSession(
  sess: Electron.Session,
  profileId: string,
  extension: BrowserExtensionLoadSource & { id?: string },
  kind: BrowserExtensionLoadKind,
  options: { refresh?: boolean } = {}
): Promise<Electron.Extension> {
  const known = extension.id ? sess.extensions.getExtension(extension.id) : null
  if (known) {
    return known
  }
  const prepared = await prepareBrowserExtensionDirectory(extension, options)
  if (extension.id && prepared.extensionId !== extension.id) {
    // Why: an unpacked folder whose id changed (e.g. a new manifest key) is a different extension.
    throw new Error('Extension id changed since it was added; remove it and add it again')
  }
  const loaded = sess.extensions.getExtension(prepared.extensionId)
  if (loaded) {
    return loaded
  }
  const registered =
    (await refreshWorkerRegistration(sess, profileId, prepared)) && prepared.hasWorker
      ? whenWorkerRegistered(sess, prepared.extensionId)
      : null
  const result = await sess.extensions.loadExtension(prepared.directory, {
    allowFileAccess: false
  })
  if (result.id !== prepared.extensionId) {
    removeBrowserExtensionFromSession(sess, result.id)
    throw new Error('Extension id changed since it was added; remove it and add it again')
  }
  await registered
  fireRuntimeLifecycleEvents(sess, profileId, result, kind)
  return result
}

/** Loads an installed extension and keeps its last failure for Settings until a load succeeds. */
async function loadInstalledIntoSession(
  sess: Electron.Session,
  profileId: string,
  extension: InstalledBrowserExtension,
  kind: BrowserExtensionLoadKind
): Promise<Electron.Extension> {
  try {
    const loaded = await loadIntoSession(sess, profileId, extension, kind)
    clearBrowserExtensionLoadFailure(profileId, extension.id)
    return loaded
  } catch (error) {
    recordBrowserExtensionLoadFailure(profileId, extension.id, error)
    throw error
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
  const installedIds = new Set(store.list().map((extension) => extension.id))
  const loading = removeOrphanedBrowserExtensionStorage(sess.getStoragePath(), installedIds)
    .catch((error: unknown) => {
      console.warn('[browser-extensions] Could not remove data of uninstalled extensions:', error)
    })
    .then(() =>
      Promise.all(
        enabledExtensionIds.map(async (extensionId) => {
          const installed = store.get(extensionId)
          if (!installed) {
            return
          }
          try {
            const loaded = await loadInstalledIntoSession(sess, profile.id, installed, 'startup')
            await sessionHooks?.loaded(sess, profile.id, loaded)
          } catch (error) {
            console.warn(`[browser-extensions] Failed to load ${extensionId}:`, error)
          }
        })
      )
    )
    .then(() => undefined)
  stateByProfileId.set(profile.id, { profile, session: sess, loading })
}

/** Unloads a profile session's extensions and Orca's wiring; its saved extension data stays. */
async function unloadProfileSession(state: ProfileSessionState): Promise<void> {
  forgetBrowserExtensionLoadFailures({ profileId: state.profile.id })
  await state.loading
  for (const extension of state.session.extensions.getAllExtensions()) {
    removeBrowserExtensionFromSession(state.session, extension.id)
  }
  forgetBrowserExtensionContexts(state.session)
  unregisterExtensionPreload(state.session)
  sessionHooks?.detached(state.session)
}

/** Profile delete: unload everything so a retired session keeps no extension running. */
export async function detachBrowserExtensionsFromProfileSession(
  profile: BrowserSessionProfile
): Promise<void> {
  const state = stateByProfileId.get(profile.id)
  if (!state) {
    return
  }
  stateByProfileId.delete(profile.id)
  getBrowserExtensionProfileStateStore().forgetProfile(profile.id)
  getBrowserExtensionSyncStorageStore().forgetProfile(profile.id)
  getBrowserExtensionDnrStore().forgetProfile(profile.id)
  await unloadProfileSession(state)
}

/** The experimental setting turned off: every profile drops its extensions until it turns on. */
export async function detachBrowserExtensionsFromAllProfileSessions(): Promise<void> {
  const states = [...stateByProfileId.values()]
  stateByProfileId.clear()
  await Promise.all(states.map(unloadProfileSession))
}

/** One profile session's startup loads, restore hooks included. */
export function whenBrowserExtensionProfileLoaded(profileId: string): Promise<void> {
  return stateByProfileId.get(profileId)?.loading ?? Promise.resolve()
}

/** Startup waits briefly so restored tabs get content scripts; a slow load never blocks launch. */
export async function whenBrowserExtensionSessionsLoaded(timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    Promise.all([...stateByProfileId.values()].map((state) => state.loading)),
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
    throw new Error('Browser profile is not available for extensions')
  }
  await state.loading
  return loadInstalledIntoSession(state.session, profileId, extension, kind)
}

/** Developer "Load unpacked": loads Orca's copy of the folder; the id comes from the copy's key. */
export async function loadBrowserExtensionFolderIntoProfile(
  profileId: string,
  directory: string
): Promise<Electron.Extension> {
  const state = stateByProfileId.get(profileId)
  if (!state) {
    throw new Error('Browser profile is not available for extensions')
  }
  await state.loading
  return loadIntoSession(
    state.session,
    profileId,
    { source: 'unpacked', path: directory },
    'other',
    { refresh: true }
  )
}

export function unloadBrowserExtensionFromProfile(profileId: string, extensionId: string): void {
  clearBrowserExtensionLoadFailure(profileId, extensionId)
  const sess = stateByProfileId.get(profileId)?.session
  if (sess?.extensions.getExtension(extensionId)) {
    removeBrowserExtensionFromSession(sess, extensionId)
  }
}

export function unloadBrowserExtensionEverywhere(extensionId: string): void {
  for (const profileId of stateByProfileId.keys()) {
    unloadBrowserExtensionFromProfile(profileId, extensionId)
  }
}
