import type { ResourceReservationRequest } from '../../../../shared/resource-reservation-binding'
import type { RuntimeWorktreeCreateResult } from '../../../../shared/runtime-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { ResourceReservationConflictError } from '../../resource-reservation-conflict'
import { WorktreeReservationCreateReceiptSchema } from '../../../../shared/worktree/reservation-create-receipt'
import type { WorktreeReservationCreateReceipt } from '../../../../shared/worktree/reservation-create-receipt'

/** Returns the workspace an earlier create already bound to this key, or null when the key is
 *  unused. Throws on a reused key whose binding disagrees — a conflict is never a silent replay. */
export async function replayReservedManagedWorktree(
  runtime: Pick<
    OrcaRuntimeService,
    'findManagedWorktreeReservation' | 'showReservedManagedWorktree'
  >,
  request: ResourceReservationRequest
): Promise<RuntimeWorktreeCreateResult | null> {
  const lookup = runtime.findManagedWorktreeReservation(request)
  if (lookup.outcome === 'conflict') {
    throw new ResourceReservationConflictError(lookup.message, {
      resourceKind: 'worktree',
      resourceId: lookup.worktreeId
    })
  }
  if (lookup.outcome === 'unbound') {
    return null
  }
  const worktree = await runtime.showReservedManagedWorktree(
    lookup.worktreeId,
    lookup.hostId,
    lookup.instanceId
  )
  const receiptResult = WorktreeReservationCreateReceiptSchema.safeParse(
    worktree.reservationCreateReceipt
  )
  if (!receiptResult.success) {
    throw new Error(
      `Reserved worktree ${lookup.worktreeId} has no valid durable create receipt for reservation replay: ${receiptResult.error.message}`
    )
  }
  const receipt = receiptResult.data
  return {
    worktree,
    lineage: worktree.lineage ?? null,
    ...(worktree.workspaceLineage !== undefined
      ? { workspaceLineage: worktree.workspaceLineage }
      : {}),
    warnings: receipt.warnings,
    ...(receipt.warning !== undefined ? { warning: receipt.warning } : {}),
    ...(receipt.startupTerminal ? { startupTerminal: receipt.startupTerminal } : {}),
    ...(receipt.agentTerminalHandle ? { agentTerminalHandle: receipt.agentTerminalHandle } : {})
  }
}

/** Makes a receipt-write failure recoverable by removing the just-created bound worktree. */
export async function recordWorktreeReservationCreateReceiptOrRollback(
  runtime: Pick<
    OrcaRuntimeService,
    'recordWorktreeReservationCreateReceipt' | 'removeManagedWorktree'
  >,
  args: {
    worktreeId: string
    hostId?: string
    receipt: WorktreeReservationCreateReceipt
  }
): Promise<void> {
  try {
    runtime.recordWorktreeReservationCreateReceipt(args.worktreeId, args.hostId, args.receipt)
  } catch (receiptError) {
    try {
      await runtime.removeManagedWorktree(`id:${args.worktreeId}`, true, false, true, args.hostId)
    } catch (rollbackError) {
      throw new AggregateError(
        [receiptError, rollbackError],
        `Worktree reservation receipt persistence and rollback failed for ${args.worktreeId}`
      )
    }
    throw receiptError
  }
}
