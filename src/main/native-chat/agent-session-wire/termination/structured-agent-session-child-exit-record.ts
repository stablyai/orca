import type { SubmissionRejectionFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import type { StructuredAgentSessionEndedEvent } from '../providers/structured-agent-session-adapter'

export type StructuredAgentSessionChildExit = {
  deathEvidenceKind?: 'kill-delivered'
  heldSends?: ReadonlySet<string>
  expected: boolean
  /** Log only; failure supplies user-facing wording. */
  reason: string
  failure?: SubmissionRejectionFact
  observedAt?: number
  startupUnanswered?: true
  /** Orca stopped the agent after its own failure; the exit stays unexpected for the turn. */
  closedByOrca?: true
}

export function structuredAgentSessionEndedEventExit(
  event: StructuredAgentSessionEndedEvent
): StructuredAgentSessionChildExit {
  return {
    expected: event.cause === 'requested-close',
    ...(event.deathEvidenceKind ? { deathEvidenceKind: event.deathEvidenceKind } : {}),
    reason: event.reason,
    ...(event.failure ? { failure: event.failure } : {}),
    ...(event.observedAt === undefined ? {} : { observedAt: event.observedAt }),
    ...(event.startupUnanswered ? { startupUnanswered: event.startupUnanswered } : {}),
    ...(event.closedByOrca ? { closedByOrca: true as const } : {})
  }
}
