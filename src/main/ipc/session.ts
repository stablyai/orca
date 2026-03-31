import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { WorkspaceSessionState } from '../../shared/types'

export function registerSessionHandlers(store: Store): void {
  ipcMain.handle('session:get', () => {
    return store.getWorkspaceSession()
  })

  ipcMain.handle('session:set', (_event, args: WorkspaceSessionState) => {
    store.setWorkspaceSession(args)
  })

  // Synchronous variant for the renderer's beforeunload handler.
  // sendSync blocks the renderer until this returns, guaranteeing the
  // data (including terminal scrollback buffers) is persisted to disk
  // before the window closes — regardless of before-quit ordering.
  ipcMain.on('session:set-sync', (event, args: WorkspaceSessionState) => {
    store.setWorkspaceSession(args)
    store.flush()
    event.returnValue = true
  })
}
