import { gitExecFileAsync } from './runner'
import { runWithGitReadCacheInvalidation } from './status'
import { invalidateWslLinkedWorktreeGitRouting } from './wsl-linked-worktree-git-routing'
import { bumpWorktreeScanGeneration } from './worktree-scan-cache'
import { invalidateSparseCheckoutState } from './worktree-sparse-checkout-cache'

/** Git repairs marker back-pointers during a move; callers migrate Orca identity and check the destination. */
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
