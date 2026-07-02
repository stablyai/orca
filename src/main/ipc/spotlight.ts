import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import { SpotlightService } from '../spotlight/spotlight-service'
import {
  startSpotlightLogCapture,
  stopSpotlightLogCapture
} from '../spotlight/spotlight-log-mirror'

// Why a module singleton with a mutable window ref: attachMainWindowServices
// re-runs on macOS dock re-activation. Reconstructing the service there would
// discard its per-repo mutex/syncing overlay while old-instance git operations
// may still be in flight, letting two instances race destructive git commands
// on the same root. Keep ONE service for the process lifetime; only retarget
// the window it notifies.
let service: SpotlightService | null = null
let currentWindow: BrowserWindow | null = null
let reconciled = false

export function registerSpotlightHandlers(mainWindow: BrowserWindow, store: Store): void {
  currentWindow = mainWindow
  if (!service) {
    service = new SpotlightService(store, () =>
      currentWindow && !currentWindow.isDestroyed() ? currentWindow : null
    )
  }
  const spotlight = service

  ipcMain.removeHandler('spotlight:getState')
  ipcMain.removeHandler('spotlight:activate')
  ipcMain.removeHandler('spotlight:sync')
  ipcMain.removeHandler('spotlight:deactivate')
  ipcMain.removeHandler('spotlight:setLogPty')
  ipcMain.removeHandler('spotlight:clearLogPty')

  ipcMain.handle('spotlight:getState', () => spotlight.getStateSnapshot())
  ipcMain.handle('spotlight:activate', (_event, args: { repoId: string; worktreeId: string }) =>
    spotlight.activate(args.repoId, args.worktreeId)
  )
  ipcMain.handle('spotlight:sync', (_event, args: { repoId: string; force?: boolean }) =>
    spotlight.sync(args.repoId, { force: args.force })
  )
  ipcMain.handle(
    'spotlight:deactivate',
    (_event, args: { repoId: string; discardBackup?: boolean }) =>
      spotlight.deactivate(args.repoId, { discardBackup: args.discardBackup })
  )
  ipcMain.handle('spotlight:setLogPty', async (_event, args: { repoId: string; ptyId: string }) => {
    const repo = store.getRepo(args.repoId)
    // Only mirror while Spotlight is actually active for a local repo — the
    // spotlightRepoRoot tab flag persists across sessions, so without this a
    // once-Spotlight terminal would keep being captured after turn-off.
    if (!repo || repo.connectionId?.trim() || !spotlight.getState(args.repoId)) {
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
    void spotlight.reconcileAll().catch((error) => {
      console.warn(
        '[spotlight] Startup reconcile failed:',
        error instanceof Error ? error.message : String(error)
      )
    })
  }
}
