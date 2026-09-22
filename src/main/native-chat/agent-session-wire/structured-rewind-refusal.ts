import {
  AGENT_SESSION_REWIND_REASONS,
  type AgentSessionRewindReason
} from '../../../shared/agent-session-rewind'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'

export function rewindRefusal(reason: AgentSessionRewindReason): {
  ok: false
  refusal: AgentSessionWireRefusal
} {
  const knownReason =
    AGENT_SESSION_REWIND_REASONS.find((value) => value === reason) ?? 'outcome-unknown'
  return {
    ok: false,
    refusal: {
      code:
        knownReason === 'outcome-unknown'
          ? 'agent_session_operation_unknown'
          : 'agent_session_operation_invalid',
      message: `agent_session_rewind:${knownReason}`,
      rewindReason: knownReason
    }
  }
}
