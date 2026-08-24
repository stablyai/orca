import type { WatcherRemovalDeadline } from './watcher-removal-drain'

/**
 * Removal-time coordination for the renderer-facing filesystem watchers.
 *
 * Worktree removal has to close any watcher holding the directory open, then either
 * restore it (removal failed) or drop the snapshot (removal succeeded). The desktop
 * implementation lives in `./filesystem-watcher`, where that bookkeeping is inseparable
 * from the `WebContents` map it suspends and replays.
 *
 * Why the default is inert rather than a throw: every entry in those maps arrives through
 * an `ipcMain` handler carrying a renderer `sender`. A host with no renderer never
 * installs one, so there is nothing to close, restore, or forget — the no-op is what the
 * desktop code itself would do against empty maps, not a silent stub hiding lost work.
 */
export type WorktreeWatcherRemoval = {
  closeLocal(worktreePath: string, deadline?: WatcherRemovalDeadline): Promise<void>
  restoreLocal(worktreePath: string): Promise<void>
  forgetLocal(worktreePath: string): void
  closeRemote(connectionId: string, worktreePath: string): Promise<void>
  restoreRemote(connectionId: string, worktreePath: string): Promise<void>
  forgetRemote(connectionId: string, worktreePath: string): void
}

const inert: WorktreeWatcherRemoval = {
  closeLocal: async () => {},
  restoreLocal: async () => {},
  forgetLocal: () => {},
  closeRemote: async () => {},
  restoreRemote: async () => {},
  forgetRemote: () => {}
}

let current: WorktreeWatcherRemoval = inert

export function setWorktreeWatcherRemoval(next: WorktreeWatcherRemoval | null): void {
  current = next ?? inert
}

export function getWorktreeWatcherRemoval(): WorktreeWatcherRemoval {
  return current
}
