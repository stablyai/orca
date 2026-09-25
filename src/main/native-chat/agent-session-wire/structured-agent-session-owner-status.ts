import type { AgentSessionHandoffStatus } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import { adapterSupportsRecord } from './structured-agent-session-provider-support'

/** The `agentSession.handoffStatus` answer. Released desktop clients gate worktree activation on
 *  `owner`, so the method outlives the terminal handoff it was named for. It reports ownership, not
 *  liveness: a chat whose agent is stopped, idle-released or still starting is owned all the same. */
export function structuredAgentSessionOwnerStatus(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'adapter'>,
  sessionId: string
): AgentSessionHandoffStatus {
  const record = deps.store.getRecord(sessionId)
  if (!record) {
    throw new Error('agent_session_identity_required')
  }
  // The refusal reveal gives: this host cannot run the chat, so it vouches for nothing.
  if (!adapterSupportsRecord(deps.adapter, record)) {
    throw new Error('structured_agent_session_unsupported')
  }
  const { handoffStage: stage, handoffOperationId: operationId } = record.lease
  if (stage === 'manual-recovery') {
    return {
      owner: 'none',
      direction: 'to-native',
      phase: 'failed',
      stage,
      operationId,
      error: {
        message: "Couldn't verify which runtime owns this session — manual recovery is required",
        recoverableOwner: 'none'
      }
    }
  }
  return {
    owner: 'native',
    direction: stage ? 'to-native' : null,
    phase: stage ? 'switching' : 'idle',
    stage,
    operationId
  }
}
