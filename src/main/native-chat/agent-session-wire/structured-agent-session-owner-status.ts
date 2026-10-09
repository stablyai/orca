import type { AgentSessionHandoffStatus } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

/** The `agentSession.handoffStatus` answer. Released desktop clients gate worktree activation on
 *  `owner`, so the method outlives the terminal handoff it was named for. It reports ownership, not
 *  liveness: a chat whose agent is stopped, idle-released or still starting is owned all the same. */
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
