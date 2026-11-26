import { ORCHESTRATION_REPLAY_ONLY_CONTRACT_VERSION } from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { RETRY_NOT_REPLAYABLE_CODE } from '../../../../../shared/orchestration/orchestration-retry-request-id'
import { OrchestrationError } from '../../orchestration-error'

/** A retry after a timeout that may have been delivered: it may only replay or join its receipt. */
export function isReplayOnlyRequest(request: { orchestrationContractVersion?: number }): boolean {
  return request.orchestrationContractVersion === ORCHESTRATION_REPLAY_ONLY_CONTRACT_VERSION
}

/** Refuse before any effect: the original may already have taken effect, so it must not run again. */
export function retryNotReplayable(
  requestId: string | undefined,
  reason: 'receipt_absent' | 'route_keeps_no_receipt'
): OrchestrationError {
  const subject = requestId ? `Mutation request ${requestId}` : 'This retry'
  return new OrchestrationError(
    RETRY_NOT_REPLAYABLE_CODE,
    reason === 'receipt_absent'
      ? `${subject} has no receipt to replay; it may already have taken effect, so it was not run again.`
      : `${subject} cannot be replayed on this route; it may already have taken effect, so it was not run again.`,
    { ...(requestId ? { requestId } : {}), reason, effectsApplied: false }
  )
}

/** For a route that keeps no receipt here, so it would run a replay-only retry as new work. */
export function refuseReplayOnly(request: {
  orchestrationContractVersion?: number
  orchestrationRequestId?: string
}): void {
  if (isReplayOnlyRequest(request)) {
    throw retryNotReplayable(request.orchestrationRequestId, 'route_keeps_no_receipt')
  }
}
