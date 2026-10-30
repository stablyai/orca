import { areStructurallyEqual } from './structural-equality'
import type { Worktree } from './workspace-list-sections'

export function areWorktreeListsEqual(
  left: readonly Worktree[],
  right: readonly Worktree[]
): boolean {
  return areStructurallyEqual(left, right)
}
