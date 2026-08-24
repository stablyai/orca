import type { IpcRenderer } from 'electron'
import {
  APP_RELAUNCH_PREPARE_ABORT_CHANNEL,
  APP_RELAUNCH_PREPARE_CHANNEL,
  APP_RELAUNCH_PREPARE_REPLY_CHANNEL,
  type AppRelaunchPrepareRequest
} from '../shared/relaunch-preparation-ipc'
import { ORCA_RENDERER_UNLOAD_PREVENTED_EVENT } from '../shared/renderer-shutdown-events'
import {
  prepareRendererForAppRestart,
  type UpdaterQuitAbortRelay
} from '../shared/renderer-restart-preparation'
import type { UpdateStatus } from '../shared/update-status-types'
import {
  ORCA_APP_RESTART_ABORTED_EVENT,
  ORCA_APP_RESTART_STARTED_EVENT,
  ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT,
  ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT
} from '../shared/updater-renderer-events'

export function registerRendererRestartIpcRelays(
  ipcRenderer: Pick<IpcRenderer, 'on'>,
  eventTarget: EventTarget,
  relay: Pick<UpdaterQuitAbortRelay, 'handleStatus' | 'abort'>
): void {
  ipcRenderer.on('updater:status', (_event, status: UpdateStatus) => {
    relay.handleStatus(status)
  })
  // Why: main abandons some installs without an error status, and only this tells the renderer.
  ipcRenderer.on('updater:quitAndInstallAborted', () => {
    relay.abort()
  })
  ipcRenderer.on('window:unload-prevented', () => {
    eventTarget.dispatchEvent(new Event(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT))
    eventTarget.dispatchEvent(new Event(ORCA_APP_RESTART_ABORTED_EVENT))
  })
}

/**
 * Answers main's pre-relaunch handshake for windows that did not invoke the
 * relaunch themselves: run the same restart preparation the invoking preload
 * ran (hot-exit backup + checkpoint join) and report a verdict so main can
 * abandon the exit instead of discarding buffers that could not be backed up.
 */
export function registerRelaunchPreparationRequestHandler(
  ipcRenderer: Pick<IpcRenderer, 'on' | 'send'>,
  eventTarget: EventTarget,
  awaitCheckpoint: () => Promise<void>
): void {
  ipcRenderer.on(APP_RELAUNCH_PREPARE_CHANNEL, (_event, request: AppRelaunchPrepareRequest) => {
    prepareRendererForAppRestart(eventTarget, {
      startedEventName: ORCA_APP_RESTART_STARTED_EVENT,
      abortedEventName: ORCA_APP_RESTART_ABORTED_EVENT,
      awaitCheckpoint
    }).then(
      () =>
        ipcRenderer.send(APP_RELAUNCH_PREPARE_REPLY_CHANNEL, {
          requestId: request?.requestId,
          ok: true
        }),
      () =>
        ipcRenderer.send(APP_RELAUNCH_PREPARE_REPLY_CHANNEL, {
          requestId: request?.requestId,
          ok: false
        })
    )
  })
  ipcRenderer.on(APP_RELAUNCH_PREPARE_ABORT_CHANNEL, () => {
    // Why: main abandoned the relaunch after this window prepared; release the restart latch.
    eventTarget.dispatchEvent(new Event(ORCA_APP_RESTART_ABORTED_EVENT))
  })
}

export async function prepareAndInvokeUpdaterInstall(
  eventTarget: EventTarget,
  relay: Pick<UpdaterQuitAbortRelay, 'markPrepared' | 'abort'>,
  invoke: () => Promise<void>,
  awaitCheckpoint: () => Promise<void>
): Promise<void> {
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
}

export async function prepareAndInvokeAppRestart(
  eventTarget: EventTarget,
  invoke: () => Promise<unknown>,
  awaitCheckpoint: () => Promise<void>
): Promise<void> {
  await prepareRendererForAppRestart(eventTarget, {
    startedEventName: ORCA_APP_RESTART_STARTED_EVENT,
    abortedEventName: ORCA_APP_RESTART_ABORTED_EVENT,
    awaitCheckpoint
  })
  try {
    await invoke()
  } catch (error) {
    eventTarget.dispatchEvent(new Event(ORCA_APP_RESTART_ABORTED_EVENT))
    throw error
  }
}
