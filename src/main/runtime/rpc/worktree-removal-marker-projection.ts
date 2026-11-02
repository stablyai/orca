import { WORKTREE_BACKGROUND_REMOVAL_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { DetectedWorktreeListResult } from '../../../shared/worktree/types'
import type {
  RuntimeWorktreeListResult,
  RuntimeWorktreePsResult
} from '../../../shared/runtime-worktree-contracts'
import {
  projectPendingWorktreeRemovals,
  type PendingWorktreeRemovals
} from '../../worktree-removal-listing'
import type { RpcContext } from './core'

// Without negotiation, CLI/host readers act on rows; omit deleting checkouts they cannot use.
export function readsWorktreeRemovalMarker(
  context: Pick<RpcContext, 'clientCapabilities'>
): boolean {
  return (
    context.clientCapabilities?.includes(WORKTREE_BACKGROUND_REMOVAL_RUNTIME_CAPABILITY) === true
  )
}

// Wait for clients showing removing or asking for the outcome; older clients get acceptance and hide the row.
export function waitsForWorktreeRemoval(
  context: Pick<RpcContext, 'clientCapabilities'>,
  params: { waitForBackgroundRemoval?: boolean }
): boolean {
  return readsWorktreeRemovalMarker(context) || params.waitForBackgroundRemoval === true
}

export function projectWorktreeListRemovals<
  T extends RuntimeWorktreeListResult | DetectedWorktreeListResult
>(
  result: T,
  context: Pick<RpcContext, 'clientCapabilities'>,
  pendingAtScan: PendingWorktreeRemovals
): T {
  const worktrees = projectPendingWorktreeRemovals<T['worktrees'][number]>(
    result.worktrees,
    (worktree) => worktree.id,
    readsWorktreeRemovalMarker(context),
    pendingAtScan
  )
  if (worktrees === result.worktrees) {
    return result
  }
  const omitted = result.worktrees.length - worktrees.length
  return 'totalCount' in result
    ? { ...result, worktrees, totalCount: result.totalCount - omitted }
    : { ...result, worktrees }
}

export function projectWorktreePsRemovals(
  result: RuntimeWorktreePsResult,
  context: Pick<RpcContext, 'clientCapabilities'>,
  pendingAtScan: PendingWorktreeRemovals
): RuntimeWorktreePsResult {
  const worktrees = projectPendingWorktreeRemovals(
    result.worktrees,
    (summary) => summary.worktreeId,
    readsWorktreeRemovalMarker(context),
    pendingAtScan
  )
  return worktrees === result.worktrees
    ? result
    : {
        ...result,
        worktrees,
        totalCount: result.totalCount - (result.worktrees.length - worktrees.length)
      }
}
