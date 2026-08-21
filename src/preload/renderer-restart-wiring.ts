import type { IpcRenderer } from 'electron'
import { MCODE_RENDERER_UNLOAD_PREVENTED_EVENT } from '../shared/renderer-shutdown-events'
import {
  prepareRendererForAppRestart,
  type UpdaterQuitAbortRelay
} from '../shared/renderer-restart-preparation'
import type { UpdateStatus } from '../shared/update-status-types'
import {
  MCODE_APP_RESTART_ABORTED_EVENT,
  MCODE_APP_RESTART_STARTED_EVENT,
  MCODE_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT,
  MCODE_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT
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
    eventTarget.dispatchEvent(new Event(MCODE_RENDERER_UNLOAD_PREVENTED_EVENT))
    eventTarget.dispatchEvent(new Event(MCODE_APP_RESTART_ABORTED_EVENT))
  })
}

export async function prepareAndInvokeUpdaterInstall(
  eventTarget: EventTarget,
  relay: Pick<UpdaterQuitAbortRelay, 'markPrepared' | 'abort'>,
  invoke: () => Promise<void>,
  awaitCheckpoint: () => Promise<void>
): Promise<void> {
  await prepareRendererForAppRestart(eventTarget, {
    startedEventName: MCODE_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT,
    abortedEventName: MCODE_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT,
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
    startedEventName: MCODE_APP_RESTART_STARTED_EVENT,
    abortedEventName: MCODE_APP_RESTART_ABORTED_EVENT,
    awaitCheckpoint
  })
  try {
    await invoke()
  } catch (error) {
    eventTarget.dispatchEvent(new Event(MCODE_APP_RESTART_ABORTED_EVENT))
    throw error
  }
}
