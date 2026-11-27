import type { IpcRenderer } from 'electron'
import { ORCA_RENDERER_UNLOAD_PREVENTED_EVENT } from '../../../shared/app-lifecycle/shutdown/renderer-shutdown-events'
import {
  prepareRendererForAppRestart,
  type UpdaterQuitAbortRelay
} from '../../../shared/app-lifecycle/shutdown/renderer-restart-preparation'
import type { UpdateStatus } from '../../../shared/updater/update-status-types'
import {
  ORCA_APP_RESTART_ABORTED_EVENT,
  ORCA_APP_RESTART_STARTED_EVENT,
  ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT,
  ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT
} from '../../../shared/updater/updater-renderer-events'

type AppRestartState = { committed: boolean; pending: boolean }
const appRestartStates = new WeakMap<EventTarget, AppRestartState>()

function appRestartState(eventTarget: EventTarget): AppRestartState {
  let state = appRestartStates.get(eventTarget)
  if (!state) {
    state = { committed: false, pending: false }
    appRestartStates.set(eventTarget, state)
  }
  return state
}

export function registerRendererRestartIpcRelays(
  ipcRenderer: Pick<IpcRenderer, 'on'>,
  eventTarget: EventTarget,
  relay: Pick<UpdaterQuitAbortRelay, 'handleStatus' | 'abort'>
): void {
  ipcRenderer.on('updater:status', (_event, status: UpdateStatus) => {
    relay.handleStatus(status)
  })
  // Main can abandon an install without emitting an error status.
  ipcRenderer.on('updater:quitAndInstallAborted', () => {
    relay.abort()
  })
  ipcRenderer.on('app:restart-committed', () => {
    appRestartState(eventTarget).committed = true
  })
  ipcRenderer.on('window:unload-prevented', () => {
    // A quit veto cannot reopen a profile whose maintenance has already committed.
    if (appRestartState(eventTarget).committed) {
      return
    }
    eventTarget.dispatchEvent(new Event(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT))
    eventTarget.dispatchEvent(new Event(ORCA_APP_RESTART_ABORTED_EVENT))
  })
}

// Windows with an install request in flight; like appRestartState.pending, it outlives any one
// caller, so reopening Settings or clicking another surface can't start a second preparation.
const updaterInstallsInFlight = new WeakMap<EventTarget, Promise<void>>()

export function prepareAndInvokeUpdaterInstall(
  eventTarget: EventTarget,
  relay: Pick<UpdaterQuitAbortRelay, 'markPrepared' | 'abort'>,
  invoke: () => Promise<void>,
  awaitCheckpoint: () => Promise<void>
): Promise<void> {
  // A repeat request shares the one in flight, so it settles (or fails) with it.
  const inFlight = updaterInstallsInFlight.get(eventTarget)
  if (inFlight) {
    return inFlight
  }
  const request = (async () => {
    await prepareRendererForAppRestart(eventTarget, {
      startedEventName: ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT,
      abortedEventName: ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT,
      awaitCheckpoint
    })
    relay.markPrepared()
    try {
      await invoke()
    } catch (error) {
      relay.abort()
      throw error
    }
  })().finally(() => {
    updaterInstallsInFlight.delete(eventTarget)
  })
  updaterInstallsInFlight.set(eventTarget, request)
  return request
}

export async function prepareAndInvokeAppRestart<T>(
  eventTarget: EventTarget,
  invoke: () => Promise<T>,
  awaitCheckpoint: () => Promise<void>,
  willRestart: (result: T) => boolean = () => true,
  isCanceled?: () => boolean
): Promise<T> {
  const state = appRestartState(eventTarget)
  if (state.pending) {
    throw new Error('App restart preparation is already in progress')
  }
  state.pending = true
  try {
    if (!state.committed) {
      await prepareRendererForAppRestart(eventTarget, {
        startedEventName: ORCA_APP_RESTART_STARTED_EVENT,
        abortedEventName: ORCA_APP_RESTART_ABORTED_EVENT,
        awaitCheckpoint,
        isCanceled
      })
    }
    try {
      const result = await invoke()
      if (!state.committed && !willRestart(result)) {
        eventTarget.dispatchEvent(new Event(ORCA_APP_RESTART_ABORTED_EVENT))
      }
      return result
    } catch (error) {
      // A failed profile move can require recovery after its writer has already closed.
      if (!state.committed) {
        eventTarget.dispatchEvent(new Event(ORCA_APP_RESTART_ABORTED_EVENT))
      }
      throw error
    }
  } finally {
    state.pending = false
  }
}
