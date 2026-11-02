import { rejectValuelessFlag } from './flags'
import { RuntimeClientError } from './runtime/types'
import {
  isOrchestrationRetryRequestId,
  RETRY_REQUEST_ID_GUIDANCE
} from '../shared/orchestration-retry-request-id'

/** Reject damaged identities: falling back to a fresh id could replay an already-applied mutation. */
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
