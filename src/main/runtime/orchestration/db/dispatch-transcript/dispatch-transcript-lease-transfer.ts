import type { OrchestrationDb } from '../orchestration-db'
import { matchesTerminalIdentity } from './dispatch-transcript-segment'
import type { TransferDispatchTranscriptSegmentParams } from './dispatch-transcript-types'

export function matchesLeaseTransferReceipt(
  receipt: ReturnType<OrchestrationDb['getMaestroWorkerLeaseTransferReceipt']>,
  params: TransferDispatchTranscriptSegmentParams
): boolean {
  return Boolean(
    receipt &&
    receipt.kind === 'settled_resource_reuse' &&
    receipt.requestId === params.leaseTransferRequestId &&
    receipt.predecessorLeaseId === params.predecessorLeaseId &&
    receipt.successorLeaseId === params.successorLeaseId &&
    receipt.fromDispatchId === params.predecessorDispatchId &&
    receipt.toDispatchId === params.successorDispatchId &&
    receipt.successor.runId === params.successorRunId &&
    receipt.successor.taskId === params.successorTaskId &&
    receipt.successor.attemptId === params.successorAttemptId &&
    matchesTerminalIdentity(receipt.predecessor, params) &&
    matchesTerminalIdentity(receipt.successor, params)
  )
}
