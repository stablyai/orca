import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import { SpotlightService } from '../spotlight/spotlight-service'
import {
  startSpotlightLogCapture,
  stopSpotlightLogCapture
} from '../spotlight/spotlight-log-mirror'

let service: SpotlightService | null = null
let reconciled = false

export function getSpotlightService(): SpotlightService | null {
  return service
}

export function registerSpotlightHandlers(mainWindow: BrowserWindow, store: Store): void {
  service = new SpotlightService(store, () => (mainWindow.isDestroyed() ? null : mainWindow))

  ipcMain.removeHandler('spotlight:getState')
  ipcMain.removeHandler('spotlight:activate')
  ipcMain.removeHandler('spotlight:sync')
  ipcMain.removeHandler('spotlight:deactivate')
  ipcMain.removeHandler('spotlight:setLogPty')
  ipcMain.removeHandler('spotlight:clearLogPty')

  ipcMain.handle('spotlight:getState', () => service!.getStateSnapshot())
  ipcMain.handle('spotlight:activate', (_event, args: { repoId: string; worktreeId: string }) =>
    service!.activate(args.repoId, args.worktreeId)
  )
  ipcMain.handle('spotlight:sync', (_event, args: { repoId: string; force?: boolean }) =>
    service!.sync(args.repoId, { force: args.force })
  )
  ipcMain.handle(
    'spotlight:deactivate',
    (_event, args: { repoId: string; discardBackup?: boolean }) =>
      service!.deactivate(args.repoId, { discardBackup: args.discardBackup })
  )
  ipcMain.handle('spotlight:setLogPty', async (_event, args: { repoId: string; ptyId: string }) => {
    const repo = store.getRepo(args.repoId)
    // Local repos only — same MVP scope as the sync engine.
    if (!repo || repo.connectionId?.trim()) {
      return
    }
    await startSpotlightLogCapture({ repoId: args.repoId, ptyId: args.ptyId, rootPath: repo.path })
  })
  ipcMain.handle('spotlight:clearLogPty', (_event, args: { repoId: string; ptyId?: string }) => {
    stopSpotlightLogCapture(args)
  })

  // Why: the git refs are the source of truth and may have changed while Orca
  // was closed (manual git use, crashes). One reconcile pass per app run.
  if (!reconciled) {
    reconciled = true
    void service.reconcileAll().catch((error) => {
      console.warn(
        '[spotlight] Startup reconcile failed:',
        error instanceof Error ? error.message : String(error)
      )
    })
  }
}
