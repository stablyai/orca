import type {
  AgentJournalResetCause,
  AgentJournalResetReason
} from '../../../shared/agent-session-journal-types'

/** The reset half of a reset frame. The cause rides ALONGSIDE the reason rather
 *  than widening it: the reason reaches paired and mobile decoders that may
 *  reject a value they have never seen, and a reader that ignores the cause
 *  still reloads. */
export type AgentSessionResetFrame = {
  type: 'reset'
  reset: AgentJournalResetReason
  resetCause?: AgentJournalResetCause
}

export function agentSessionResetFrame(
  reset: AgentJournalResetReason,
  cause?: AgentJournalResetCause
): AgentSessionResetFrame {
  return { type: 'reset', reset, ...(cause ? { resetCause: cause } : {}) }
}
