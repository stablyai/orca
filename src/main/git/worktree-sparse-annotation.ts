import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type { GitWorktreeExecOptions } from './worktree-operation-options'
import { detectSparseCheckoutCached } from './worktree-sparse-checkout-cache'

const SPARSE_CHECKOUT_DETECTION_CONCURRENCY = 8

export async function annotateSparseCheckoutStatus(
  repoPath: string,
  worktrees: GitWorktreeInfo[],
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  const annotated = [...worktrees]
  let nextIndex = 0

  async function detectNext(): Promise<void> {
    while (nextIndex < worktrees.length) {
      const index = nextIndex
      nextIndex += 1
      const worktree = worktrees[index]
      if (!worktree || worktree.isBare || worktree.isSparse) {
        continue
      }
      const isSparse = await detectSparseCheckoutCached(repoPath, worktree.path, options)
      if (isSparse) {
        annotated[index] = { ...worktree, isSparse }
      }
    }
  }

  // Why: cap concurrency so status-poll refreshes don't fan out many sparse-checkout filesystem probes at once.
  const workerCount = Math.min(SPARSE_CHECKOUT_DETECTION_CONCURRENCY, worktrees.length)
  await Promise.all(Array.from({ length: workerCount }, () => detectNext()))
  return annotated
}
