import { rejectValuelessFlag } from './flags'
import { RuntimeClientError } from './runtime/types'
import {
  isOrchestrationRetryRequestId,
  RETRY_REQUEST_ID_GUIDANCE
} from '../shared/orchestration-retry-request-id'

/**
 * `--retry-request` carries the mutation identity that makes a replay idempotent. A damaged value
 * must never fall through to `undefined`, because the client would then mint a fresh identity and
 * re-apply a mutation that may already have taken effect (#15180).
 */
export function readRetryRequestFlag(flags: Map<string, string | boolean>): string | undefined {
  const value = flags.get('retry-request')
  rejectValuelessFlag(value, 'retry-request')
  if (value === undefined) {
    return undefined
  }
  if (!isOrchestrationRetryRequestId(value)) {
    throw new RuntimeClientError('invalid_argument', RETRY_REQUEST_ID_GUIDANCE)
  }
  return value
}
