import {
  onJournalReceiptCommitted,
  type JournalOperationReceipt
} from '../../agent-session-journal/writing/journal-row-writer'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import type { AgentSessionRewindRecord } from '../../../../shared/agent-session/lifecycle/rewind/agent-session-rewind'
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
  if (current.phase === 'refused') {
    delete current.providerRevert
    if (current.providerFork) {
      const { coverage: _coverage, ...fork } = current.providerFork
      current.providerFork = fork
    }
  }
  return store.updateRecord(sessionId, { kind: 'rewind', fence, rewind: current })
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

export function inheritForkName(
  deps: RewindRecoveryDeps,
  sessionId: string,
  receipt: JournalOperationReceipt
): JournalOperationReceipt {
  return onJournalReceiptCommitted(receipt, () => {
    const record = deps.store.getRecord(sessionId)
    if (record?.rewind?.providerFork?.materialized) {
      deps.nameProviderConversation?.(record)
    }
  })
}
