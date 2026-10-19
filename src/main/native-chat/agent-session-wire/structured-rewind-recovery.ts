import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import { structuredRewindCut } from './structured-rewind-cut'
import type { AgentSessionRewindRecord } from '../../../shared/agent-session-rewind'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { rewindRefusal } from './structured-rewind-refusal'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import type { JournalOperationReceipt } from '../agent-session-journal/journal-row-writer'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'

type RewindRecoveryDeps = { store: AgentSessionRecordStore; logger: StructuredAgentSessionLogger }

export function persistRewindRecord(
  store: AgentSessionRecordStore,
  sessionId: string,
  fence: number,
  rewind: AgentSessionRewindRecord
): Promise<unknown> {
  // An older build's record copied the kept history; the journal holds it, so it is never rewritten.
  const { retained: _retained, hydrationVerified: _hydrationVerified, ...current } = rewind
  return store.transitionHandoff(sessionId, (record) => {
    if (record.lease.runtimeFence !== fence) {
      throw new Error('agent_session_checkpoint_stale')
    }
    return { ...record, rewind: current }
  })
}

/**
 * Claude rewind is unsupported, so a pending one (an older build's, or an interrupted one) is
 * settled refused rather than proven. Bookkeeping only: the chat is already attached either way.
 */
async function settleUnsupportedClaudeRewind(
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

/** Recovery observes provider state; it never repeats an ambiguous native mutation. */
export async function recoverStructuredRewind(
  deps: RewindRecoveryDeps,
  sessionId: string,
  journal: AgentSessionJournal,
  fence: number,
  adapter?: StructuredAgentSessionAdapter,
  receipt?: (
    rewind: AgentSessionRewindRecord,
    fence: number,
    cursor: AgentJournalCursor
  ) => JournalOperationReceipt,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const { store } = deps
  let rewind = store.getRecord(sessionId)?.rewind
  if (rewind?.phase !== 'provider-succeeded' && rewind?.phase !== 'prepared') {
    return
  }
  const target = parseAgentJournalItemKey(rewind.providerItemId ?? rewind.itemId)
  if (target?.provider === 'claude') {
    await settleUnsupportedClaudeRewind(deps, sessionId, fence, rewind)
    return
  }
  // Only this rewind moves a chat to a new epoch once it has history (imports run at creation), so
  // a moved epoch is its own replacement, committed before the crash.
  const alreadyReplaced = journal.cursor().epoch !== rewind.expectedEpoch
  const record = store.getRecord(sessionId)
  const head = record && agentSessionProviderHandleChainHead(record.providerHandleChain)?.handle
  const cut =
    alreadyReplaced || !record || !head
      ? null
      : structuredRewindCut(journal, {
          itemId: rewind.itemId,
          provider: record.provider,
          nativeId: head.nativeId
        })
  if (!alreadyReplaced && !cut) {
    throw new Error('agent_session_rewind:invalid-target')
  }
  if (rewind.phase === 'prepared') {
    if (!cut) {
      throw new Error('agent_session_rewind:outcome-unknown')
    }
    const read = adapter?.recoverRewind?.({
      sessionId,
      fence,
      beforeTurnId: cut.beforeTurnId,
      keptTurnId: cut.keptTurnId,
      ...(signal ? { signal } : {})
    })
    const recovered = signal
      ? await waitForPromiseWithSignal(Promise.resolve(read), signal)
      : await read
    signal?.throwIfAborted()
    if (!recovered?.ok) {
      // The target is still in the provider's history, and the journal is replaced only once the
      // revert is proven, so both still hold it even when the provider acknowledged the revert.
      if (recovered?.reason === 'provider-refused') {
        await persistRewindRecord(store, sessionId, fence, {
          ...rewind,
          phase: 'refused',
          reason: recovered.reason
        })
        return
      }
      throw new Error(`agent_session_rewind:${recovered?.reason ?? 'outcome-unknown'}`)
    }
    rewind = { ...rewind, phase: 'provider-succeeded' }
    await persistRewindRecord(store, sessionId, fence, rewind)
  }
  if (rewind.phase !== 'provider-succeeded') {
    return
  }
  if (rewind.contextClearOperationId && rewind.contextClearSequence) {
    if (
      store.getRecord(sessionId)?.providerContextBoundary?.operationId !==
        rewind.contextClearOperationId ||
      journal.cursor().epoch !== rewind.expectedEpoch ||
      journal.context.floor()?.sequence !== rewind.contextClearSequence
    ) {
      throw new Error('agent_session_rewind:stale-context')
    }
    const completed = rewind
    await journal.context.rewind(
      { epoch: completed.expectedEpoch, sequence: completed.contextClearSequence! },
      fence,
      cut!.kept,
      (cursor) =>
        receipt?.(completed, fence, cursor) ??
        store.conversationReceipts.rewind(sessionId, fence, completed, cursor)
    )
    return
  }
  const cursor = alreadyReplaced
    ? journal.cursor()
    : await journal.replaceEpochItems('handle_forked', fence, cut!.kept)
  await persistRewindRecord(store, sessionId, fence, {
    ...rewind,
    phase: 'completed',
    epoch: cursor.epoch
  })
  await store.recordOperationOutcome({
    callerKey: rewind.callerKey,
    operationId: rewind.operationId,
    outcome: {
      status: 'succeeded',
      sessionId,
      rewind: { itemId: rewind.itemId, epoch: cursor.epoch }
    }
  })
}
