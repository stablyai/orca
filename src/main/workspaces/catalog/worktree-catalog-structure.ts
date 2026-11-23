import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import type { WorktreeCatalogOutcome } from './repo-worktree-catalog-observation'

/** HEAD moves have their own channel; only rows that change what the sidebar lists count. */
function sameRow(a: GitWorktreeInfo, b: GitWorktreeInfo): boolean {
  return (
    a.path === b.path &&
    a.branch === b.branch &&
    a.isBare === b.isBare &&
    a.isMainWorktree === b.isMainWorktree &&
    a.isSparse === b.isSparse &&
    a.locked === b.locked &&
    a.lockReason === b.lockReason &&
    a.prunable === b.prunable &&
    a.prunableReason === b.prunableReason
  )
}

export function sameWorktreeCatalogStructure(
  a: WorktreeCatalogOutcome,
  b: WorktreeCatalogOutcome
): boolean {
  if (a.kind !== 'rows' || b.kind !== 'rows') {
    return a.kind === b.kind
  }
  return (
    a.worktrees.length === b.worktrees.length &&
    a.worktrees.every((row, index) => sameRow(row, b.worktrees[index]))
  )
}
