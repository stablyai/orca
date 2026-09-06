import type { IpcRenderer } from 'electron'
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
  relay: Pick<UpdaterQuitAbortRelay, 'handleStatus' | 'abort'>,
  requestUpdaterInstall?: () => Promise<void>
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
  // Why: a quit deferred during macOS staging still needs the normal hot-exit checkpoint.
  ipcRenderer.on('updater:quitAndInstallRequested', () => {
    void requestUpdaterInstall?.().catch((error) => {
      console.error('[updater] Deferred install preparation failed:', error)
    })
  })
}

// Why: downloaded status and a deferred request can land together; one latch must own both.
let updaterInstallAttempt: Promise<void> | null = null

export async function prepareAndInvokeUpdaterInstall(
  eventTarget: EventTarget,
  relay: Pick<UpdaterQuitAbortRelay, 'markPrepared' | 'abort'>,
  invoke: () => Promise<void>,
  awaitCheckpoint: () => Promise<void>
): Promise<void> {
  if (updaterInstallAttempt) {
    return updaterInstallAttempt
  }
  const attempt = (async (): Promise<void> => {
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
  })()
  updaterInstallAttempt = attempt
  try {
    await attempt
  } finally {
    if (updaterInstallAttempt === attempt) {
      updaterInstallAttempt = null
    }
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
