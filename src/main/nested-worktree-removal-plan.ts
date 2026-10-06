import type { GitWorktreeInfo } from '../shared/worktree/types'
import type { NestedWorktreeRemovalApproval } from '../shared/worktree/nested-removal'
import { assertWorktreeUnlockedForRemoval } from '../shared/worktree/removal'
import { areWorktreePathsEqual } from './ipc/worktree-logic'
import {
  containsPath,
  getPathOps,
  type WorktreeRemovalHomeAuthority
} from './worktree-removal-home-guard'
import { getRegisteredDeletableWorktree } from './worktree-removal-safety'

export function getNestedWorktreeRemovalPlan(args: {
  repoPath: string
  worktreePath: string
  worktrees: readonly GitWorktreeInfo[]
  home: WorktreeRemovalHomeAuthority
}): GitWorktreeInfo[] {
  const nested = args.worktrees.filter(
    (item) =>
      !areWorktreePathsEqual(item.path, args.worktreePath) &&
      containsPath(args.worktreePath, item.path, getPathOps(args.worktreePath, item.path))
  )
  const targets = [
    ...nested.sort((left, right) => right.path.length - left.path.length),
    ...args.worktrees.filter((item) => areWorktreePathsEqual(item.path, args.worktreePath))
  ]
  let remaining = args.worktrees
  for (const target of targets) {
    const registered = getRegisteredDeletableWorktree(
      args.repoPath,
      target.path,
      remaining,
      args.home
    )
    assertWorktreeUnlockedForRemoval(registered)
    remaining = remaining.filter((item) => !areWorktreePathsEqual(item.path, target.path))
  }
  if (!targets.some((target) => areWorktreePathsEqual(target.path, args.worktreePath))) {
    throw new Error(`Refusing to delete unregistered worktree path: ${args.worktreePath}`)
  }
  return targets
}

export function assertNestedWorktreeRemovalApproval(
  plan: readonly GitWorktreeInfo[],
  approved: readonly NestedWorktreeRemovalApproval[]
): void {
  if (
    plan.length !== approved.length ||
    plan.some(
      (target) =>
        !approved.some(
          (item) =>
            areWorktreePathsEqual(item.path, target.path) &&
            item.head === target.head &&
            item.branch === target.branch
        )
    )
  ) {
    throw new Error(
      'The nested worktree list or its branches changed. Review the worktrees again before deleting.'
    )
  }
}
