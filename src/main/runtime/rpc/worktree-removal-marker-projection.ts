import { WORKTREE_BACKGROUND_REMOVAL_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { DetectedWorktreeListResult } from '../../../shared/worktree/types'
import type {
  RuntimeWorktreeListResult,
  RuntimeWorktreePsResult
} from '../../../shared/runtime-worktree-contracts'
import {
  projectPendingWorktreeRemovals,
  type PendingWorktreeRemovals
} from '../../worktree-background-removal'
import type { RpcContext } from './core'

// Why no in-process default: callers without negotiation (the CLI, host-side readers) print or act
// on rows, and a checkout mid-delete is not a workspace they can use.
export function readsWorktreeRemovalMarker(
  context: Pick<RpcContext, 'clientCapabilities'>
): boolean {
  return (
    context.clientCapabilities?.includes(WORKTREE_BACKGROUND_REMOVAL_RUNTIME_CAPABILITY) === true
  )
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
