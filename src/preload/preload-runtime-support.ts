import { ipcRenderer } from 'electron'
import { createBrowserClientPageRendererRequests } from './browser-client-page-renderer-requests'
import { createBrowserFindSubscriptions } from './browser-find-subscriptions'
import { registerRendererRestartIpcRelays } from './renderer-restart-wiring'
import { createUpdaterQuitAbortRelay } from '../shared/renderer-restart-preparation'
import { ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT } from '../shared/updater-renderer-events'
/** Joins the synchronous unload checkpoint with its durable renderer write. */
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

/** Registers browser find forwarding once for this preload context. */
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
