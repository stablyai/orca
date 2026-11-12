import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { refuse } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'

export function advisoryOperationRefusal(record: AgentSessionRecord | null, method: string) {
  return record?.advisoryPolicy &&
    method !== 'agentSession.send' &&
    method !== 'agentSession.cancel'
    ? refuse(
        'agent_session_operation_invalid',
        { reason: 'advisoryOperationUnsupported' },
        'This advisory session only accepts its original question and Stop.'
      )
    : null
}
