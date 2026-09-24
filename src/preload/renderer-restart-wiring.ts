import type { IpcRenderer } from 'electron'
import { ORCA_RENDERER_UNLOAD_PREVENTED_EVENT } from '../shared/renderer-shutdown-events'
import {
  prepareRendererForAppRestart,
  type UpdaterQuitAbortRelay
} from '../shared/renderer-restart-preparation'
import type { UpdateStatus } from '../shared/update-status-types'
import {
  ORCA_APP_RESTART_ABORTED_EVENT,
  ORCA_APP_RESTART_COMMITTED_EVENT,
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
  ipcRenderer.on('app:restart-committed', () => {
    eventTarget.dispatchEvent(new Event(ORCA_APP_RESTART_COMMITTED_EVENT))
  })
  ipcRenderer.on('window:unload-prevented', () => {
    eventTarget.dispatchEvent(new Event(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT))
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

export async function prepareAndInvokeAppRestart<T>(
  eventTarget: EventTarget,
  invoke: () => Promise<T>,
  awaitCheckpoint: () => Promise<void>,
  willRestart: (result: T) => boolean = () => true
): Promise<T> {
  await prepareRendererForAppRestart(eventTarget, {
    startedEventName: ORCA_APP_RESTART_STARTED_EVENT,
    abortedEventName: ORCA_APP_RESTART_ABORTED_EVENT,
    awaitCheckpoint
  })
  let committed = false
  const markCommitted = (): void => {
    committed = true
  }
  eventTarget.addEventListener(ORCA_APP_RESTART_COMMITTED_EVENT, markCommitted)
  try {
    const result = await invoke()
    if (!committed && !willRestart(result)) {
      eventTarget.dispatchEvent(new Event(ORCA_APP_RESTART_ABORTED_EVENT))
    }
    return result
  } catch (error) {
    // A failed profile move can require recovery after its writer has already closed.
    if (!committed) {
      eventTarget.dispatchEvent(new Event(ORCA_APP_RESTART_ABORTED_EVENT))
    }
    throw error
  } finally {
    eventTarget.removeEventListener(ORCA_APP_RESTART_COMMITTED_EVENT, markCommitted)
  }
}
