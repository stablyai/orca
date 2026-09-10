import type { MaestroTerminalLeaseTransferReceipt } from '../../../../../shared/maestro-terminal-lease-transfer'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import { getAcceptedMutationDispatchId } from './maestro-terminal-lease-transfer-receipt'

export function assertCurrentRunTransferGeneration(
  db: OrchestrationDb,
  params: { runId: string; coordinatorGeneration: number | null }
): void {
  const run = db.getRun(params.runId)
  if (
    run &&
    (params.coordinatorGeneration === null ||
      run.consumer_generation !== params.coordinatorGeneration)
  ) {
    throw new OrchestrationError(
      'consumer_fenced',
      'Worker lease transfer is fenced by the current Run generation.'
    )
  }
}

export function assertPendingTransferMutation(
  db: OrchestrationDb,
  mutation: MaestroTerminalLeaseTransferReceipt['mutation'],
  successorDispatchId: string
): void {
  if (!mutation) {
    return
  }
  const stored = db.getMutationReceipt(mutation.callerFingerprint, mutation.requestId)
  if (
    !stored ||
    stored.state !== 'pending' ||
    stored.method !== mutation.method ||
    stored.payload_hash !== mutation.payloadHash ||
    getAcceptedMutationDispatchId(stored.receipt) !== successorDispatchId
  ) {
    throw new OrchestrationError(
      'request_mismatch',
      'Worker lease transfer does not match the pending worker-start mutation.'
    )
  }
}
