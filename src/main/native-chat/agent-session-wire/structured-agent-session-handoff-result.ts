import type {
  AgentSessionHandoffResult,
  AgentSessionMutationResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionHandoffDeps } from './structured-agent-session-handoff-types'

export function structuredHandoffRefusal(
  code: AgentSessionWireRefusal['code'],
  message: string
): AgentSessionWireRefusal {
  return { code, message }
}

export function structuredHandoffSuccess(
  deps: StructuredAgentSessionHandoffDeps,
  sessionId: string,
  replayed: boolean,
  status: AgentSessionHandoffResult['status']
): AgentSessionMutationResult<AgentSessionHandoffResult> {
  const record = deps.store.getRecord(sessionId)
  if (!record) {
    throw new Error('agent_session_identity_required')
  }
  return {
    ok: true,
    replayed,
    fence: record.lease.runtimeFence,
    cursor: deps.session(sessionId).journal.cursor(),
    value: { status }
  }
}
