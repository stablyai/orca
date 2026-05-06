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

  // Why: called by the renderer after a successful session hydration to ungate
  // the debounced session writer. Without this, the error-handler path (empty
  // tabs) could be picked up by the writer and permanently overwrite the user's
  // session data on disk.
  ipcMain.handle('session:mark-hydration-succeeded', () => {
    store.markHydrationSucceeded()
  })
}
