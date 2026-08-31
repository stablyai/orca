import { gitExecFileAsync } from './runner'
import { runWithGitReadCacheInvalidation } from './status'
import { bumpWorktreeScanGeneration } from './worktree-scan-cache'

/**
 * Move a worktree with `git worktree move` (not `fs.rename`, which corrupts the
 * `.git` file and the `.git/worktrees/<name>/gitdir` back-pointer). Local-only,
 * so there is no relay parity handler. Caller owns migrating Orca's
 * path-derived worktree identity and pre-checks that the destination is free.
 */
export async function moveWorktree(
  repoPath: string,
  oldPath: string,
  newPath: string
): Promise<void> {
  try {
    await runWithGitReadCacheInvalidation(() =>
      gitExecFileAsync(['worktree', 'move', oldPath, newPath], { cwd: repoPath })
    )
  } finally {
    bumpWorktreeScanGeneration(repoPath)
  }
}
