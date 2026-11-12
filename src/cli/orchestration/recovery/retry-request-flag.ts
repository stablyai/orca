import { rejectValuelessFlag } from '../../arguments/flags'
import { RuntimeClientError } from '../../runtime/types'
import {
  isOrchestrationRetryRequestId,
  RETRY_REQUEST_ID_GUIDANCE
} from '../../../shared/orchestration/orchestration-retry-request-id'

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

/** A caller-supplied key can outlive the CLI process; it does not prove a first effect. */
export function readRequestIdFlag(flags: Map<string, string | boolean>): string | undefined {
  const value = flags.get('request-id')
  rejectValuelessFlag(value, 'request-id')
  if (value === undefined) {
    return undefined
  }
  if (!isOrchestrationRetryRequestId(value)) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--request-id must be a caller-generated UUID persisted before sending.'
    )
  }
  if (flags.has('retry-request')) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--request-id and --retry-request cannot be combined.'
    )
  }
  return value
}
