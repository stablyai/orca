import type { WorktreeWatcherRemoval } from './worktree-watcher-removal'
import {
  closeLocalWatcherForWorktreePath,
  forgetLocalWatcherRemovalSnapshot,
  restoreLocalWatcherAfterFailedRemoval
} from './filesystem-watcher-local-removal'
import {
  closeRemoteWatcherForWorktreePath,
  forgetRemoteWatcherRemovalSnapshot,
  restoreRemoteWatcherAfterFailedRemoval
} from './filesystem-watcher-remote-removal'

export { closeLocalWatcherForWorktreePath } from './filesystem-watcher-local-removal'
export { restoreLocalWatcherAfterFailedRemoval } from './filesystem-watcher-local-removal'
export { forgetLocalWatcherRemovalSnapshot } from './filesystem-watcher-local-removal'
export { closeRemoteWatcherForWorktreePath } from './filesystem-watcher-remote-removal'
export { restoreRemoteWatcherAfterFailedRemoval } from './filesystem-watcher-remote-removal'
export { forgetRemoteWatcherRemovalSnapshot } from './filesystem-watcher-remote-removal'
export { registerFilesystemWatcherHandlers } from './filesystem-watcher-handlers'
export { closeAllWatchers } from './filesystem-watcher-shutdown'

// ── Public API ───────────────────────────────────────────────────────

/** The desktop binding for {@link WorktreeWatcherRemoval}. Installed during startup. */
export const desktopWorktreeWatcherRemoval: WorktreeWatcherRemoval = {
  closeLocal: (worktreePath, deadline) =>
    deadline
      ? closeLocalWatcherForWorktreePath(worktreePath, deadline)
      : closeLocalWatcherForWorktreePath(worktreePath),
  restoreLocal: restoreLocalWatcherAfterFailedRemoval,
  forgetLocal: forgetLocalWatcherRemovalSnapshot,
  closeRemote: closeRemoteWatcherForWorktreePath,
  restoreRemote: restoreRemoteWatcherAfterFailedRemoval,
  forgetRemote: forgetRemoteWatcherRemovalSnapshot
}
