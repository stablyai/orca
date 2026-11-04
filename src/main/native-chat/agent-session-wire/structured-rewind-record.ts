import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import type { AgentSessionRewindRecord } from '../../../shared/agent-session/lifecycle/agent-session-rewind'
import type { RewindRecoveryDeps } from './structured-rewind-recovery'
import { rewindRefusal } from './structured-rewind-refusal'

export function persistRewindRecord(
  store: AgentSessionRecordStore,
  sessionId: string,
  fence: number,
  rewind: AgentSessionRewindRecord
): Promise<unknown> {
  // Drop legacy copied history; the retained journal remains authoritative.
  const { retained: _retained, hydrationVerified: _hydrationVerified, ...current } = rewind
  return store.transitionHandoff(sessionId, (record) => {
    if (record.lease.runtimeFence !== fence) {
      throw new Error('agent_session_checkpoint_stale')
    }
    return { ...record, rewind: current }
  })
}

/** Pre-fork Claude rewinds never ran; refuse them without blocking the already-attached chat. */
export async function settleUnsupportedClaudeRewind(
  { store, logger }: RewindRecoveryDeps,
  sessionId: string,
  fence: number,
  rewind: AgentSessionRewindRecord
): Promise<void> {
  const refusal = rewindRefusal('unsupported').refusal
  try {
    await persistRewindRecord(store, sessionId, fence, {
      ...rewind,
      phase: 'refused',
      reason: 'unsupported'
    })
    await store.recordOperationOutcome({
      callerKey: rewind.callerKey,
      operationId: rewind.operationId,
      outcome: { status: 'failed', code: refusal.code, rewindReason: 'unsupported' }
    })
  } catch (error) {
    logger.warn('a pending Claude rewind was not settled', {
      scope: 'rewind-unsupported-settlement',
      sessionId,
      operationId: rewind.operationId,
      error
    })
  }
}
