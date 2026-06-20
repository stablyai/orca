import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { WorkspaceSessionPatch, WorkspaceSessionState } from '../../shared/types'

export function registerSessionHandlers(store: Store): void {
  // Why: hostId is an optional second arg so an older renderer that invokes
  // these channels without it keeps reading/writing the 'local' partition
  // exactly as before. Channel names stay stable.
  ipcMain.handle('session:get', (_event, hostId?: string | null) => {
    return store.getWorkspaceSession(hostId)
  })

  ipcMain.handle('session:set', (_event, args: WorkspaceSessionState, hostId?: string | null) => {
    store.setWorkspaceSession(args, hostId)
  })

  ipcMain.handle('session:patch', (_event, args: WorkspaceSessionPatch, hostId?: string | null) => {
    store.patchWorkspaceSession(args, hostId)
  })

  // Synchronous variant for the renderer's beforeunload handler.
  // sendSync blocks the renderer until this returns, guaranteeing the
  // data (including terminal scrollback buffers) is persisted to disk
  // before the window closes — regardless of before-quit ordering.
  ipcMain.on('session:set-sync', (event, args: WorkspaceSessionState, hostId?: string | null) => {
    store.setWorkspaceSession(args, hostId)
    store.flush()
    event.returnValue = true
  })

  ipcMain.on(
    'session:read-terminal-scrollback-sync',
    (event, args: { ref?: unknown } | undefined) => {
      event.returnValue =
        typeof args?.ref === 'string' ? store.readTerminalScrollbackSnapshot(args.ref) : null
    }
  )
}
