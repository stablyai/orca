import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionHandoffStatus } from '../../../shared/agent-session-wire'

/** The `agentSession.handoffStatus` answer. Released desktop clients gate worktree activation on
 *  `owner`, so the method outlives the terminal handoff it was named for. */
export function structuredAgentSessionOwnerStatus(
  record: AgentSessionRecord
): AgentSessionHandoffStatus {
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
    owner: record.lease.claimStatus === 'live' && record.lease.ownerProcess ? 'native' : 'none',
    direction: stage ? 'to-native' : null,
    phase: stage ? 'switching' : 'idle',
    stage,
    operationId
  }
}
