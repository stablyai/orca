import type { WorktreeWatcherRemoval } from './worktree-watcher-removal'
import {
  closeLocalWatcherForWorktreePath,
  forgetLocalWatcherRemovalSnapshot,
  restoreLocalWatcherAfterFailedRemoval
} from './filesystem-watcher-local-removal'

/** The desktop binding for {@link WorktreeWatcherRemoval}. Installed during startup. */
export const desktopWorktreeWatcherRemoval: WorktreeWatcherRemoval = {
  closeLocal: (worktreePath, deadline) =>
    deadline
      ? closeLocalWatcherForWorktreePath(worktreePath, deadline)
      : closeLocalWatcherForWorktreePath(worktreePath),
  restoreLocal: restoreLocalWatcherAfterFailedRemoval,
  forgetLocal: forgetLocalWatcherRemovalSnapshot
}
