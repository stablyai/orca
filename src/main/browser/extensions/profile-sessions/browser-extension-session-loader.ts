export {
  withBrowserExtensionProfileOperation,
  loadBrowserExtensionIntoProfile,
  loadBrowserExtensionFolderIntoProfile
} from './browser-extension-profile-loading'
import {
  sessionHooks,
  completeBrowserExtensionProfileLoad,
  stateByProfileId,
  type ProfileSessionState
} from './browser-extension-profile-session-state'
export {
  setBrowserExtensionSessionHooks,
  type BrowserExtensionSessionHooks
} from './browser-extension-profile-session-state'
import {
  attachBrowserExtensionProfileDemand,
  detachBrowserExtensionProfileDemand,
  forgetBrowserExtensionTargetDemand
} from './browser-extension-profile-demand'
export {
  retainBrowserExtensionPage,
  refreshBrowserExtensionPageDemand,
  hasBrowserExtensionProfileDemand
} from './browser-extension-profile-demand'
import { browserSessionRegistry } from '../../sessions/profiles/browser-session-registry'
import {
  getBrowserExtensionExecution,
  retireBrowserExtensionExecution
} from '../api-runtime/browser-extension-execution-authority'
import { session } from 'electron'
import { forgetBrowserExtensionActionProfile } from '../actions/browser-extension-action-registry'
import {
  registerBrowserSessionFramePreload,
  unregisterBrowserSessionFramePreload
} from '../../sessions/browser-session-frame-preloads'
import type { BrowserSessionProfile } from '../../../../shared/browser-workspace-types'
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
import {
  reconcileBrowserExtensionProfileData,
  removeReinstalledBrowserExtensionData
} from '../profile-storage/browser-extension-data-removal'
import {
  clearBrowserExtensionLoadFailure,
  forgetBrowserExtensionLoadFailures
} from './browser-extension-load-errors'
import {
  BrowserExtensionProfileLoads,
  throwIfBrowserExtensionLoadCancelled
} from './browser-extension-profile-loads'
import { removeBrowserExtensionFromSession } from './browser-extension-worker-registration'
import { loadInstalledBrowserExtensionIntoSession } from './browser-extension-session-load'

const PRELOAD_FILE_NAME = 'browser-extension-preload.js'
const PRELOAD_ID = 'orca-browser-extension-frame'

// Workers load Orca's API shim through the background wrapper instead.
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
  const sess = session.fromPartition(profile.partition)
  registerExtensionPreload(sess)
  attachBrowserExtensionApiHostToSession(sess, profile.id)
  sessionHooks?.attached(sess, profile.id, enabledExtensionIds)
  const state: ProfileSessionState = {
    profile,
    session: sess,
    loads: new BrowserExtensionProfileLoads(),
    loading: Promise.resolve(),
    started: new Set()
  }
  stateByProfileId.set(profile.id, state)
  attachBrowserExtensionProfileDemand(
    profile.id,
    (id, page) => activateProfile(state, id, page),
    (id) => suspendTarget(state, id),
    () => browserSessionRegistry.getEnabledExtensionIds(profile.id),
    (ready) => {
      state.loading = ready
      sessionHooks?.activating?.(sess, ready)
    }
  )
}

function activateProfile(
  state: ProfileSessionState,
  extensionId: string,
  page: boolean
): Promise<void> {
  return state.loads.track(extensionId, async (load) => {
    const stale = page
      ? await reconcileBrowserExtensionProfileData(state.session, state.profile.id, (ids) =>
          sessionHooks?.uninstalled(state.profile.id, ids)
        )
      : await removeReinstalledBrowserExtensionData(state.session, state.profile.id, extensionId)
    if (!page && stale.size > 0) {
      sessionHooks?.uninstalled(state.profile.id, stale)
    }
    throwIfBrowserExtensionLoadCancelled(load)
    const installed = getBrowserExtensionInstallStore().get(extensionId)
    if (!installed || stale.has(extensionId)) {
      return
    }
    const loaded = await loadInstalledBrowserExtensionIntoSession(
      state.session,
      state.profile.id,
      installed,
      state.started.has(extensionId) ? 'other' : 'startup',
      load
    )
    throwIfBrowserExtensionLoadCancelled(load)
    await completeBrowserExtensionProfileLoad(state, loaded, load)
  })
}

function suspendTarget(state: ProfileSessionState, id: string): Promise<void> {
  const cancelled = state.loads.cancel(id)
  const execution = getBrowserExtensionExecution(state.session, id)
  const retiring = retireBrowserExtensionExecution(state.session, id)
  // A reopened page shares this queue with work admitted by its predecessor.
  const queued = state.loads.track(id, () => retiring)
  if (state.session.extensions.getExtension(id)) {
    removeBrowserExtensionFromSession(state.session, id, 'suspend')
  }
  return Promise.all([cancelled, queued, execution?.retired]).then(() => undefined)
}

function suspendProfile(state: ProfileSessionState): Promise<void> {
  const ids = new Set([
    ...state.session.extensions.getAllExtensions().map((extension) => extension.id),
    ...state.started,
    ...browserSessionRegistry.getEnabledExtensionIds(state.profile.id)
  ])
  return Promise.all([
    state.loads.cancel(null),
    ...[...ids].map((id) => suspendTarget(state, id))
  ]).then(() => undefined)
}

/** Unloads a profile session's extensions and Orca's wiring; its saved extension data stays. */
async function unloadProfileSession(state: ProfileSessionState): Promise<void> {
  forgetBrowserExtensionLoadFailures({ profileId: state.profile.id })
  await suspendProfile(state)
  await Promise.all(
    [
      ...new Set([
        ...state.started,
        ...browserSessionRegistry.getEnabledExtensionIds(state.profile.id)
      ])
    ].map((id) => resetExtension(state, id))
  )
  await state.loads.close()
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
  const state = stateByProfileId.get(profile.id)
  const sess = state?.session ?? session.fromPartition(profile.partition)
  if (state) {
    stateByProfileId.delete(profile.id)
    detachBrowserExtensionProfileDemand(profile.id)
  }
  try {
    if (state) {
      await unloadProfileSession(state)
    }
    await retireBrowserExtensionProfileStorage(sess, profile.partition).catch((error: unknown) => {
      console.warn('[browser-extensions] Could not clear deleted profile storage:', error)
    })
  } finally {
    forgetBrowserExtensionActionProfile(profile.id)
    getBrowserExtensionProfileStateStore().forgetProfile(profile.id)
    getBrowserExtensionSyncStorageStore().forgetProfile(profile.id)
    getBrowserExtensionDnrStore().forgetProfile(profile.id)
  }
}

/** The extensions setting turned off: every profile drops its extensions until it turns on. */
export async function detachBrowserExtensionsFromAllProfileSessions(): Promise<void> {
  const states = [...stateByProfileId.values()]
  stateByProfileId.clear()
  for (const state of states) {
    detachBrowserExtensionProfileDemand(state.profile.id)
  }
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

/** Unloads it and cancels its loads in flight, which stop at their next step. */
export function unloadBrowserExtensionFromProfile(
  profileId: string,
  extensionId: string
): Promise<unknown> {
  return unloadAndCancel(profileId, extensionId)
}

function resetExtension(
  state: ProfileSessionState,
  extensionId: string,
  retiring: Promise<void> = Promise.resolve()
): Promise<void> {
  // The same queue orders a cold reset before any successor's first original instruction.
  return state.loads.track(extensionId, async () => {
    await retiring
    await sessionHooks?.reset?.(state.session, state.profile.id, extensionId)
  })
}

function unloadAndCancel(profileId: string, extensionId: string): Promise<unknown> {
  clearBrowserExtensionLoadFailure(profileId, extensionId)
  const state = stateByProfileId.get(profileId)
  if (!state) {
    return Promise.resolve()
  }
  forgetBrowserExtensionTargetDemand(profileId, extensionId)
  const stopped = state.loads.cancel(extensionId)
  const retired = retireBrowserExtensionExecution(state.session, extensionId)
  if (state.session.extensions.getExtension(extensionId)) {
    removeBrowserExtensionFromSession(state.session, extensionId)
  }
  const reset = resetExtension(state, extensionId, retired)
  return Promise.all([stopped, retired, reset])
}

/** Resolves once its cancelled loads have stopped, so removal can purge what they wrote. */
export async function unloadBrowserExtensionEverywhere(extensionId: string): Promise<void> {
  await Promise.all(
    [...stateByProfileId.keys()].map((profileId) => unloadAndCancel(profileId, extensionId))
  )
}
