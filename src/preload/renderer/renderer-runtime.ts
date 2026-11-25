import { ipcRenderer } from 'electron'
import { createBrowserClientPageRendererRequests } from './browser-pages/browser-client-page-renderer-requests'
import { createBrowserFindSubscriptions } from './browser-pages/browser-find-subscriptions'
import {
  prepareAndInvokeAppRestart,
  registerRendererRestartIpcRelays
} from './restart/renderer-restart-wiring'
import { createUpdaterQuitAbortRelay } from '../../shared/app-lifecycle/shutdown/renderer-restart-preparation'
import {
  formatShutdownCheckpointFailureReason,
  ORCA_NATIVE_UNLOAD_FAILED_EVENT,
  publishShutdownCheckpointFailureReason
} from '../../shared/app-lifecycle/shutdown/renderer-shutdown-events'
import {
  ORCA_APP_RESTART_ABORTED_EVENT,
  ORCA_AUTOMATIC_UPDATE_PREPARE_EVENT,
  ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT
} from '../../shared/updater/updater-renderer-events'
export async function awaitBeforeUnloadCheckpoint(): Promise<void> {
  const result = (await ipcRenderer.invoke('app:await-before-unload-checkpoint')) as {
    ok?: unknown
  }
  if (result?.ok !== true) {
    throw new Error('Failed to persist renderer state before unload.')
  }
}

export const startupDiagnosticsEnabled = process.env.ORCA_STARTUP_DIAGNOSTICS === '1'

export function getLinuxDisplayServer(): 'wayland' | 'x11' | null {
  if (process.platform !== 'linux') {
    return null
  }
  if (
    process.env.WAYLAND_DISPLAY ||
    process.env.XDG_SESSION_TYPE?.toLowerCase() === 'wayland' ||
    process.env.ELECTRON_OZONE_PLATFORM_HINT?.toLowerCase() === 'wayland'
  ) {
    return 'wayland'
  }
  return process.env.DISPLAY ? 'x11' : null
}

export const browserFindSubscriptions = createBrowserFindSubscriptions()
export const browserClientPageRendererRequests = createBrowserClientPageRendererRequests({
  ipc: ipcRenderer,
  isTopFrame: () => window.top === window
})
let browserFindListenerInstalled = false

export function installBrowserFindListener(): void {
  if (browserFindListenerInstalled) {
    return
  }
  ipcRenderer.on('ui:findInBrowserPage', (_event, source: unknown) => {
    browserFindSubscriptions.dispatch(source)
  })
  browserFindListenerInstalled = true
}

export const updaterQuitAbortRelay = createUpdaterQuitAbortRelay(
  window,
  ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT
)

registerRendererRestartIpcRelays(ipcRenderer, window, updaterQuitAbortRelay)

/** Main runs the checkpoint through app:prepare-native-unload, which reports its own failure. */
export async function invokeRendererRequestedReload(): Promise<void> {
  await ipcRenderer.invoke('app:reload')
}

const nativeUnloadRequests = new Set<string>()
let preparedNativeUnload: string | undefined
let updateInputHold: { requestId: string; release: () => void } | undefined

function holdUpdateInput(requestId: string): void {
  const body = document.body
  if (body) {
    const previous = body.inert
    body.inert = true
    updateInputHold = {
      requestId,
      release: () => {
        body.inert = previous
      }
    }
  }
}

function releaseUpdateInput(requestId: string): void {
  if (updateInputHold?.requestId === requestId) {
    updateInputHold.release()
    updateInputHold = undefined
  }
}

// Main asks before menu, shortcut, DevTools and in-app reloads; prepare exactly like the renderer's own restart.
ipcRenderer.on('app:prepare-native-unload', (_event, requestId: unknown, purpose: unknown) => {
  if (typeof requestId !== 'string') {
    return
  }
  // Acknowledge before preparing so main can tell a frozen renderer from a slow save.
  ipcRenderer.send('app:native-unload-received', requestId)
  if (purpose === 'update') {
    if (
      !window.dispatchEvent(new Event(ORCA_AUTOMATIC_UPDATE_PREPARE_EVENT, { cancelable: true }))
    ) {
      ipcRenderer.send('app:native-unload-prepared', { requestId, ok: false })
      return
    }
    // Keep local input from creating state after the final checkpoint.
    holdUpdateInput(requestId)
  }
  nativeUnloadRequests.add(requestId)
  void prepareAndInvokeAppRestart(
    window,
    async () => {
      if (nativeUnloadRequests.delete(requestId)) {
        preparedNativeUnload = requestId
        ipcRenderer.send('app:native-unload-prepared', { requestId, ok: true })
      }
    },
    awaitBeforeUnloadCheckpoint,
    undefined,
    () => !nativeUnloadRequests.has(requestId)
  ).catch((error: unknown) => {
    releaseUpdateInput(requestId)
    if (!nativeUnloadRequests.delete(requestId)) {
      return
    }
    // Preparation consumed the staging reason; republish so the toast names why the reload stopped.
    if (purpose !== 'update') {
      publishShutdownCheckpointFailureReason(formatShutdownCheckpointFailureReason(error))
      window.dispatchEvent(new Event(ORCA_NATIVE_UNLOAD_FAILED_EVENT))
    }
    ipcRenderer.send('app:native-unload-prepared', { requestId, ok: false })
  })
})

// Main gave up waiting or replaced the reload with a close; restore the ordinary unload guards.
ipcRenderer.on('app:native-unload-canceled', (_event, requestId: unknown) => {
  if (typeof requestId !== 'string') {
    return
  }
  releaseUpdateInput(requestId)
  const pending = nativeUnloadRequests.delete(requestId)
  if (pending || preparedNativeUnload === requestId) {
    preparedNativeUnload = undefined
    window.dispatchEvent(new Event(ORCA_APP_RESTART_ABORTED_EVENT))
  }
})
