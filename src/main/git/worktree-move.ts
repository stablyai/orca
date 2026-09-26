import { gitExecFileAsync } from './runner'
import { runWithGitReadCacheInvalidation } from './status'
import { invalidateWslLinkedWorktreeGitRouting } from './wsl-linked-worktree-git-routing'
import { bumpWorktreeScanGeneration } from './worktree-scan-cache'
import { invalidateSparseCheckoutState } from './worktree-sparse-checkout-cache'

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
    // A failed move can still have rewritten one `.git` marker, so re-probe both paths.
    invalidateWslLinkedWorktreeGitRouting(oldPath)
    invalidateWslLinkedWorktreeGitRouting(newPath)
    invalidateSparseCheckoutState(repoPath, oldPath)
    invalidateSparseCheckoutState(repoPath, newPath)
    bumpWorktreeScanGeneration(repoPath)
  }
}
