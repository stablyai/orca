import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import { SpotlightService } from '../spotlight/spotlight-service'
import {
  startSpotlightLogCapture,
  stopSpotlightLogCapture
} from '../spotlight/spotlight-log-mirror'

// Module singleton with a mutable window ref: attachMainWindowServices re-runs on
// macOS dock re-activation, and rebuilding the service would drop its per-repo
// mutex while old git operations are still in flight — letting two instances race
// destructive git on the same root. One service per process; only retarget the window.
let service: SpotlightService | null = null
let currentWindow: BrowserWindow | null = null
let reconciled = false

/** Turn Spotlight off before a repo/holder is torn down, so the root doesn't
 *  stay detached on the snapshot with the log capture leaked. No-op when the
 *  repo isn't holding the Spotlight. Deactivate is idempotent and swallows its
 *  own errors, so callers (repo removal, worktree deletion) can await it
 *  unconditionally without failing the teardown. */
export async function deactivateSpotlightBeforeTeardown(repoId: string): Promise<void> {
  if (!service || !service.getState(repoId)) {
    return
  }
  await service.deactivate(repoId)
  // If deactivate couldn't finish (merge/rebase in the root, or a restore
  // conflict), removeProject is about to drop the record — orphaning the refs
  // with no reconcile left to reach them. Force-clean them, keeping the backup
  // ref for manual recovery. No-op when deactivate already cleared the record.
  if (service.getState(repoId)) {
    await service.purgeForTeardown(repoId)
  }
  // Even if deactivate couldn't complete (e.g. a merge/rebase in progress), the
  // repo is being removed — stop the capture so its PTY listener, .orca watcher,
  // and file handle don't leak. No-op when deactivate already stopped it.
  stopSpotlightLogCapture({ repoId })
}

/** Deactivate before the CURRENT holder worktree is deleted, so the root is
 *  restored instead of frozen on a snapshot that points at a worktree about to
 *  vanish (which would silently kill auto-sync and leave the badge lying).
 *  No-op unless this worktree is the active holder. */
export async function deactivateSpotlightIfHolder(
  repoId: string,
  worktreeId: string
): Promise<void> {
  if (!service || service.getState(repoId)?.holderWorktreeId !== worktreeId) {
    return
  }
  await service.deactivate(repoId)
  // As above: the holder worktree is about to be deleted, so release the capture
  // even if the restore couldn't complete.
  stopSpotlightLogCapture({ repoId })
}

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
