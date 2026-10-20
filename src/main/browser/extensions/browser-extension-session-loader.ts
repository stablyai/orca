import { session } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserSessionProfile } from '../../../shared/browser-workspace-types'
import type { InstalledBrowserExtension } from '../../../shared/browser-extension-types'
import { getChromeExtensionOrigin } from '../../../shared/browser-extension-url'
import { isBrowserExtensionSupportEnabled } from './browser-extension-support'
import { getBrowserExtensionInstallStore } from './browser-extension-install-store'
import { getBrowserExtensionProfileStateStore } from './browser-extension-profile-state-store'
import { getBrowserExtensionSyncStorageStore } from './browser-extension-sync-storage-store'
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
  type BrowserExtensionLoadSource,
  type PreparedBrowserExtensionDirectory
} from './browser-extension-load-directory'

type ProfileSessionState = {
  profile: BrowserSessionProfile
  session: Electron.Session
  loading: Promise<void>
}

/** Per-session services and per-extension restart restore, supplied by browser-extension-startup. */
export type BrowserExtensionSessionHooks = {
  attached: (sess: Electron.Session, profileId: string) => void
  /** Runs after each startup load; resolves when restored state is back in place. */
  loaded: (
    sess: Electron.Session,
    profileId: string,
    extension: Electron.Extension
  ) => Promise<void>
}

let sessionHooks: BrowserExtensionSessionHooks | null = null

export function setBrowserExtensionSessionHooks(hooks: BrowserExtensionSessionHooks): void {
  sessionHooks = hooks
}

const PRELOAD_FILE_NAME = 'browser-extension-preload.js'
const stateByProfileId = new Map<string, ProfileSessionState>()
const preloadedSessions = new WeakSet<Electron.Session>()

function registerExtensionPreload(sess: Electron.Session): void {
  if (preloadedSessions.has(sess)) {
    return
  }
  preloadedSessions.add(sess)
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
  sess.registerPreloadScript({ id: 'orca-browser-extension-frame', type: 'frame', filePath })
}

/**
 * Chromium keeps running a worker's cached scripts until the extension version changes, so a new
 * wrapper or shim would never run. Dropping the registration makes the load register it afresh.
 * Returns whether it did, i.e. whether the load will register the worker.
 */
async function refreshWorkerRegistration(
  sess: Electron.Session,
  profileId: string,
  prepared: PreparedBrowserExtensionDirectory
): Promise<boolean> {
  const { extensionId, workerSignature } = prepared
  const states = getBrowserExtensionProfileStateStore()
  if (workerSignature && states.read(profileId, extensionId).workerSignature === workerSignature) {
    return false
  }
  await sess.clearStorageData({
    origin: getChromeExtensionOrigin(extensionId),
    storages: ['serviceworkers']
  })
  if (workerSignature) {
    states.update(profileId, extensionId, (state) => ({ ...state, workerSignature }))
  }
  return true
}

const WORKER_REGISTRATION_WAIT_MS = 10_000

/**
 * loadExtension resolves before Chromium has registered the worker, and until it has, every start
 * fails ("Failed to start service worker."). The load waits so Orca's lifecycle events and
 * restored tabs start a worker that exists. Listen before loading: registration can finish first.
 */
function whenWorkerRegistered(sess: Electron.Session, extensionId: string): Promise<void> {
  const scope = `${getChromeExtensionOrigin(extensionId)}/`
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      sess.serviceWorkers.removeListener('registration-completed', onRegistered)
      resolve()
    }
    const onRegistered = (_event: Electron.Event, details: { scope: string }): void => {
      if (details.scope === scope) {
        done()
      }
    }
    const timer = setTimeout(done, WORKER_REGISTRATION_WAIT_MS)
    sess.serviceWorkers.on('registration-completed', onRegistered)
  })
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
  const result = await sess.extensions.loadExtension(prepared.directory, { allowFileAccess: false })
  if (result.id !== prepared.extensionId) {
    sess.extensions.removeExtension(result.id)
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
  sessionHooks?.attached(sess, profile.id)
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
  forgetBrowserExtensionLoadFailures({ profileId: profile.id })
  await state.loading
  for (const extension of state.session.extensions.getAllExtensions()) {
    state.session.extensions.removeExtension(extension.id)
  }
  forgetBrowserExtensionContexts(state.session)
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
    sess.extensions.removeExtension(extensionId)
  }
}

export function unloadBrowserExtensionEverywhere(extensionId: string): void {
  for (const profileId of stateByProfileId.keys()) {
    unloadBrowserExtensionFromProfile(profileId, extensionId)
  }
}
