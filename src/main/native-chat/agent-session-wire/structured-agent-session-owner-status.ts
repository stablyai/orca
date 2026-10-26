import type { AgentSessionHandoffStatus } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

/** Legacy clients gate activation on owner; report ownership even for stopped/starting children. */
export function structuredAgentSessionOwnerStatus(
  deps: Pick<StructuredAgentSessionHostDeps, 'store'>,
  sessionId: string
): AgentSessionHandoffStatus {
  const record = deps.store.getRecord(sessionId)
  if (!record) {
    throw new Error('agent_session_identity_required')
  }
  const { handoffStage: stage, handoffOperationId: operationId } = record.lease
  return {
    owner: 'native',
    direction: stage ? 'to-native' : null,
    phase: stage ? 'switching' : 'idle',
    stage,
    operationId
  }
}
