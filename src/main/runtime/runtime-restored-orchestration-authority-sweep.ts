import { runtimeWorktreeIdsEqual } from './runtime-worktree-path-identity'
import type { ExecutionHostId } from '../../shared/execution-host'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../shared/execution-host'
import type { RestoredOrchestrationAuthorityReceipt } from './runtime-terminal-contracts'

/**
 * Retire orchestration receipts a completed inventory proved absent.
 * A provider that failed to list is absent from the inventory, and dropping authority on
 * that silence would retire an orchestration handle the relay can still reach.
 */
export function retireOrchestrationAuthorityAbsentFromInventory(
  receiptsByPtyId: Map<string, RestoredOrchestrationAuthorityReceipt>,
  {
    queriedHostIds,
    allLivePtyIds,
    connectionId,
    targetWorktreeId
  }: {
    queriedHostIds: ReadonlySet<ExecutionHostId>
    allLivePtyIds: ReadonlySet<string>
    connectionId?: string | null
    targetWorktreeId?: string | null
  }
): void {
  for (const [ptyId, receipt] of receiptsByPtyId) {
    if (targetWorktreeId && !runtimeWorktreeIdsEqual(receipt.worktreeId, targetWorktreeId)) {
      continue
    }
    const receiptHostId =
      receipt.hostScope.kind === 'ssh'
        ? toSshExecutionHostId(receipt.hostScope.targetId)
        : LOCAL_EXECUTION_HOST_ID
    const inScope =
      queriedHostIds.has(receiptHostId) &&
      (connectionId === undefined ||
        (connectionId === null && receipt.hostScope.kind !== 'ssh') ||
        (typeof connectionId === 'string' &&
          receipt.hostScope.kind === 'ssh' &&
          receipt.hostScope.targetId === connectionId))
    if (inScope && !allLivePtyIds.has(ptyId)) {
      receiptsByPtyId.delete(ptyId)
    }
  }
}

/**
 * A scoped refresh must skip inventory sessions outside its target workspace,
 * but a session the controller just reassigned away from that workspace
 * still invalidates the receipt it left behind there.
 */
export function skipSessionOutsideTargetWorktree(
  receiptsByPtyId: Map<string, RestoredOrchestrationAuthorityReceipt>,
  {
    ptyId,
    worktreeId,
    trackedWorktreeId,
    targetWorktreeId
  }: {
    ptyId: string
    worktreeId: string | null
    trackedWorktreeId: string | null | undefined
    targetWorktreeId: string | null
  }
): boolean {
  const outsideTarget =
    targetWorktreeId &&
    (!worktreeId ||
      !runtimeWorktreeIdsEqual(worktreeId, targetWorktreeId) ||
      (trackedWorktreeId && !runtimeWorktreeIdsEqual(trackedWorktreeId, targetWorktreeId)))
  if (!outsideTarget) {
    return false
  }
  const receipt = receiptsByPtyId.get(ptyId)
  if (
    worktreeId &&
    !runtimeWorktreeIdsEqual(worktreeId, targetWorktreeId) &&
    receipt &&
    runtimeWorktreeIdsEqual(receipt.worktreeId, targetWorktreeId)
  ) {
    // Why: the controller's reassignment invalidates only the former workspace's receipt.
    receiptsByPtyId.delete(ptyId)
  }
  return true
}

/** A scoped refresh reconciles only its target workspace's PTYs on the queried connection. */
export function isPtyOutsideRefreshScope(
  pty: { worktreeId: string; connectionId: string | null },
  targetWorktreeId: string | null,
  connectionId: string | null | undefined
): boolean {
  return (
    (targetWorktreeId !== null && !runtimeWorktreeIdsEqual(pty.worktreeId, targetWorktreeId)) ||
    (connectionId !== undefined && pty.connectionId !== connectionId)
  )
}
