import { refuse } from '../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionMutationEnvelope } from '../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionHostDeps } from './agent-session-wire/structured-agent-session-host-types'

/** Called inside the native serialization lane, before opening or mutating a child. */
export function quotaContinuationRefusal(
  deps: StructuredAgentSessionHostDeps,
  callerKey: string,
  envelope: AgentSessionMutationEnvelope
) {
  return deps.quotaFallbackSendAllowed?.(
    envelope.sessionId,
    envelope.clientOperationId,
    callerKey
  ) === false
    ? refuse(
        'agent_session_operation_invalid',
        { reason: 'handoffInFlight' },
        'A quota continuation owns this session. Wait for it to settle.'
      )
    : null
}
