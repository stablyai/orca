import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import type { NestedWorktreeRemovalApproval } from '../../../shared/worktree/removal/nested-removal'
import { composeWorktreeId } from '../../../shared/worktree/id'
import type { RemoveWorktreeResult } from '../../../shared/worktree/create-types'
import { assertWorktreeUnlockedForRemoval } from '../../../shared/worktree/removal/removal'
import { areWorktreePathsEqual } from '../../git/worktrees/catalog/worktree-path-comparison'
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

export type NestedPreservedBranches = NonNullable<RemoveWorktreeResult['nestedPreservedBranches']>

/** Deletes a plan's nested children deepest-first, stopping at the first failure. */
export async function removeNestedWorktreePlanChildren(
  repoId: string,
  plan: readonly GitWorktreeInfo[],
  removeChild: (worktreeId: string, child: GitWorktreeInfo) => Promise<RemoveWorktreeResult>
): Promise<NestedPreservedBranches> {
  const preserved: NestedPreservedBranches = []
  for (const child of plan.slice(0, -1)) {
    const worktreeId = composeWorktreeId(repoId, child.path)
    try {
      const result = await removeChild(worktreeId, child)
      if (result.preservedBranch) {
        preserved.push({ worktreeId, ...result.preservedBranch })
      }
    } catch (error) {
      const kept =
        preserved.length > 0
          ? ` Branches kept after earlier deletions: ${preserved.map((item) => item.branchName).join(', ')}.`
          : ''
      throw new Error(
        `Could not delete nested worktree ${child.path}: ${error instanceof Error ? error.message : String(error)}${kept}`,
        { cause: error }
      )
    }
  }
  return preserved
}

/** Names nested deletions that already happened when the parent's own delete fails. */
export function withNestedPreservedBranches(
  error: unknown,
  preserved: NestedPreservedBranches
): unknown {
  if (preserved.length === 0) {
    return error
  }
  return new Error(
    `${error instanceof Error ? error.message : String(error)} Branches kept after nested deletions: ${preserved.map((item) => item.branchName).join(', ')}.`,
    { cause: error }
  )
}
