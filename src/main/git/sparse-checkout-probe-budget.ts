import { STARTUP_WORKTREE_HYDRATION_LIMIT } from '../../shared/startup-worktree-hydration-budget'
import type { GitWorktreeInfo } from '../../shared/worktree/types'

/** Indexes worth a foreground sparse probe. Over-limit catalogs probe the main
 * checkout plus a bounded prefix and leave historical linked checkouts lazy. */
export function selectSparseCheckoutProbeIndexes(
  worktrees: readonly GitWorktreeInfo[],
  limit = STARTUP_WORKTREE_HYDRATION_LIMIT
): number[] {
  const mains: number[] = []
  const linked: number[] = []
  for (let index = 0; index < worktrees.length; index += 1) {
    const worktree = worktrees[index]
    if (!worktree || worktree.isBare || worktree.isSparse) {
      continue
    }
    if (worktree.isMainWorktree) {
      mains.push(index)
    } else {
      linked.push(index)
    }
  }
  if (worktrees.length <= limit) {
    return [...mains, ...linked]
  }
  const selected = mains.slice(0, limit)
  for (const index of linked) {
    if (selected.length >= limit) {
      break
    }
    selected.push(index)
  }
  return selected
}
