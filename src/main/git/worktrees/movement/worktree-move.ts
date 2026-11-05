import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { runWithGitReadCacheInvalidation } from '../../source-control/git-read-cache-invalidation'
import { invalidateWslLinkedWorktreeGitRouting } from '../../command-runner/wsl-linked-worktree-git-routing'
import { bumpWorktreeScanGeneration } from '../catalog/worktree-scan-cache'
import { invalidateSparseCheckoutState } from '../sparse-checkout/worktree-sparse-checkout-cache'

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
