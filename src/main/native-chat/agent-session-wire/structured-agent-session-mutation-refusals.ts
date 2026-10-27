import { refuse, type AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import { AGENT_SESSION_UNATTACHED_REFUSAL_CODE } from '../../../shared/structured-agent-session-read-refusal'

export const AGENT_SESSION_NOT_ATTACHED: AgentSessionWireRefusal = refuse(
  AGENT_SESSION_UNATTACHED_REFUSAL_CODE,
  { reason: 'sessionNotAttached' },
  'This host holds no attached session by that id.'
)

export function refuseAgentSessionMutation(refusal: AgentSessionWireRefusal): {
  ok: false
  refusal: AgentSessionWireRefusal
} {
  return { ok: false, refusal }
}
