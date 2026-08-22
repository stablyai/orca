import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { Store } from '../persistence'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'
import { getWindowSessionRegistry } from '../persistence/window-session-registry'
import { orcaWindowManager } from '../window/orca-window-manager'

function requireWindowId(event: IpcMainEvent | IpcMainInvokeEvent): number {
  const window = orcaWindowManager.getWindowForSender(event.sender)
  if (!window) {
    throw new Error('untrusted_ui_renderer')
  }
  return window.id
}

export function registerSessionHandlers(store: Store): void {
  const sessions = getWindowSessionRegistry(store)
  // Why: hostId is an optional second arg so an older renderer that invokes
  // these channels without it keeps reading/writing the 'local' partition
  // exactly as before. Channel names stay stable.
  ipcMain.handle('session:get', (event, hostId?: string | null) => {
    return sessions.get(requireWindowId(event), hostId)
  })

  ipcMain.handle('session:set', (event, args: WorkspaceSessionState, hostId?: string | null) => {
    sessions.set(requireWindowId(event), args, hostId)
  })

  ipcMain.handle('session:patch', (event, args: WorkspaceSessionPatch, hostId?: string | null) => {
    sessions.patch(requireWindowId(event), args, hostId)
  })

  ipcMain.handle('session:flush', (event) => {
    requireWindowId(event)
    // Why: durable lifecycle RPCs must propagate disk failures instead of
    // returning success through Store.flush(), which intentionally only logs.
    store.flushOrThrow()
  })

  // Synchronous variant for the renderer's beforeunload handler.
  // sendSync blocks the renderer until this returns, guaranteeing the
  // data (including terminal scrollback buffers) is persisted to disk
  // before the window closes — regardless of before-quit ordering.
  ipcMain.on('session:set-sync', (event, args: WorkspaceSessionState, hostId?: string | null) => {
    sessions.set(requireWindowId(event), args, hostId)
    store.flush()
    event.returnValue = true
  })

  ipcMain.on(
    'session:read-terminal-scrollback-sync',
    (event, args: { ref?: unknown } | undefined) => {
      requireWindowId(event)
      event.returnValue =
        typeof args?.ref === 'string' ? store.readTerminalScrollbackSnapshot(args.ref) : null
    }
  )
}
