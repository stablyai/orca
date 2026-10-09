import {
  AGENT_SESSION_REWIND_REASONS,
  type AgentSessionRewindReason
} from '../../../shared/agent-session-rewind'
import { refuse, type AgentSessionWireRefusal } from '../../../shared/agent-session-wire'

export function rewindRefusal(reason: AgentSessionRewindReason): {
  ok: false
  refusal: AgentSessionWireRefusal
} {
  const rewindReason =
    AGENT_SESSION_REWIND_REASONS.find((value) => value === reason) ?? 'outcome-unknown'
  const message = `agent_session_rewind:${rewindReason}`
  return {
    ok: false,
    refusal:
      rewindReason === 'outcome-unknown'
        ? refuse(
            'agent_session_operation_unknown',
            { reason: 'rewindUnconfirmed', rewindReason },
            message
          )
        : refuse(
            'agent_session_operation_invalid',
            { reason: 'rewindRefused', rewindReason },
            message
          )
  }
}
