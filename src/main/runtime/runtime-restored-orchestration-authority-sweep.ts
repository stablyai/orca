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
    connectionId
  }: {
    queriedHostIds: ReadonlySet<ExecutionHostId>
    allLivePtyIds: ReadonlySet<string>
    connectionId?: string | null
  }
): void {
  for (const [ptyId, receipt] of receiptsByPtyId) {
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
