// Unknown delivery never authorizes redelivery under the same ID; only a new user send rotates it.
// Process facts end acknowledgement waits; elapsed time alone proves neither delivery nor rejection.

import { STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING } from '../../../shared/structured-agent-session-send-evidence'

export const DISPATCH_DOUBT_HOST_RESTARTED = 'host_restarted_before_acknowledgement'

export const DISPATCH_DOUBT_PROVIDER_EXITED = 'provider_exited_before_acknowledgement'

export const DISPATCH_DOUBT_PERSISTENCE_FAILED = 'dispatch_result_persistence_failed'

export const DISPATCH_DOUBT_SUBMISSION_MISSING = STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING

// Provider idleness leaves no open turn that could acknowledge the send.
export const DISPATCH_DOUBT_PROVIDER_IDLE = 'provider_idle_before_acknowledgement'

export const DISPATCH_DOUBT_PROVIDER_ENDED_UNANSWERED = 'provider_ended_before_acknowledgement'

export const DISPATCH_DOUBT_WRITE_OUTCOME_UNKNOWN = 'provider_write_outcome_unknown'

export function dispatchWriteOutcomeUnknownReason(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `${DISPATCH_DOUBT_WRITE_OUTCOME_UNKNOWN}: ${detail}`
}
