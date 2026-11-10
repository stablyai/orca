import {
  refuse,
  refuseUnclassified,
  type AgentSessionWireRefusal
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'

export function operationDidNotRun(expired = false): {
  ok: false
  refusal: AgentSessionWireRefusal
} {
  return {
    ok: false,
    refusal: expired
      ? refuse(
          'agent_session_operation_expired',
          { reason: 'operationExpired' },
          'The operation did not run because its wait expired. Try again.'
        )
      : refuseUnclassified(
          'agent_session_owner_restart_failed',
          'The operation did not run because the agent is not ready.'
        )
  }
}
