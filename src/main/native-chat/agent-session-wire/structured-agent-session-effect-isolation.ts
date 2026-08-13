import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionHandoffResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import { refuseAgentSessionMutation } from './structured-agent-session-mutation-admission'

export function refuseEffectIsolatedHandoff(
  record: AgentSessionRecord | null
): AgentSessionMutationResult<AgentSessionHandoffResult> | null {
  return record?.effectIsolation === 'local-structured-write'
    ? refuseAgentSessionMutation({
        code: 'agent_session_operation_invalid',
        message: 'An effect-isolated writer session cannot hand off to a terminal owner.'
      })
    : null
}
