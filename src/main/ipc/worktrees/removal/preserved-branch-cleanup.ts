import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import { preservedBranchCleanupScopeKey } from '../../../../shared/preserved-branch-cleanup'

export type PreservedBranchCleanupTarget = {
  worktreeId: string
  hostId: ExecutionHostId
  branchName: string
  head: string
  pushTarget?: GitPushTarget
}

export const preservedBranchCleanupByScope = new Map<string, PreservedBranchCleanupTarget>()

export function rememberPreservedBranchCleanupTarget(
  worktreeId: string,
  hostId: ExecutionHostId,
  result: RemoveWorktreeResult | undefined,
  fallbackHead: string | undefined,
  pushTarget: GitPushTarget | undefined
): void {
  if (result?.preservedBranch) {
    const head = result.preservedBranch.head ?? fallbackHead
    if (!head) {
      throw new Error(
        `Cannot safely offer force-delete for preserved branch "${result.preservedBranch.branchName}" without its saved commit.`
      )
    }
    preservedBranchCleanupByScope.set(preservedBranchCleanupScopeKey({ worktreeId, hostId }), {
      worktreeId,
      hostId,
      branchName: result.preservedBranch.branchName,
      head,
      ...(pushTarget ? { pushTarget } : {})
    })
    return
  }
  preservedBranchCleanupByScope.delete(preservedBranchCleanupScopeKey({ worktreeId, hostId }))
}

export function preserveBranchHeadFallback(
  result: RemoveWorktreeResult | undefined,
  fallbackHead: string | undefined
): RemoveWorktreeResult {
  if (!result?.preservedBranch || result.preservedBranch.head || !fallbackHead) {
    return result ?? {}
  }
  return {
    ...result,
    preservedBranch: {
      ...result.preservedBranch,
      head: fallbackHead
    }
  }
}

export function getPreservedBranchCleanupTarget(
  worktreeId: string,
  branchName: string,
  expectedHead: string,
  hostId?: ExecutionHostId
): PreservedBranchCleanupTarget {
  const exactTarget = hostId
    ? preservedBranchCleanupByScope.get(preservedBranchCleanupScopeKey({ worktreeId, hostId }))
    : undefined
  const legacyMatches = hostId
    ? []
    : [...preservedBranchCleanupByScope.values()].filter(
        (target) =>
          target.worktreeId === worktreeId &&
          target.branchName === branchName &&
          target.head === expectedHead
      )
  const target = exactTarget ?? (legacyMatches.length === 1 ? legacyMatches[0] : undefined)
  if (!target || target.branchName !== branchName || target.head !== expectedHead) {
    throw new Error(`No preserved branch cleanup is pending for "${branchName}".`)
  }
  return target
}
