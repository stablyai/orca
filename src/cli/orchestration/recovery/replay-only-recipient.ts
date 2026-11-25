import { ORCHESTRATION_REPLAY_ONLY_RETRY_RUNTIME_CAPABILITY } from '../../../shared/orchestration/orchestration-runtime-capabilities'
import { RETRY_NOT_REPLAYABLE_CODE } from '../../../shared/orchestration/orchestration-retry-request-id'
import type { RuntimeRequestSelection } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { RuntimeClientError } from '../../runtime/connection/types'

/**
 * Asks the runtime for its status on the same connection that will carry the replay, and sends
 * the replay only if that runtime enforces replay-only. A release without the contract fence
 * would run the replay as a new send, so an unproven recipient gets nothing.
 */
export function replayOnlyRecipientCheck(params: unknown): RuntimeRequestSelection {
  return {
    paramsForStatus: (status) => {
      if (advertisesReplayOnly(status)) {
        return params
      }
      throw new RuntimeClientError(
        RETRY_NOT_REPLAYABLE_CODE,
        'The connected Orca cannot replay this request without risking a second copy, so the retry was not sent.',
        { reason: 'recipient_cannot_replay', requestSent: false, effectsApplied: false }
      )
    }
  }
}

function advertisesReplayOnly(status: unknown): boolean {
  if (typeof status !== 'object' || status === null || !('capabilities' in status)) {
    return false
  }
  const { capabilities } = status
  return (
    Array.isArray(capabilities) &&
    capabilities.includes(ORCHESTRATION_REPLAY_ONLY_RETRY_RUNTIME_CAPABILITY)
  )
}
