import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import { isDeepStrictEqual } from 'node:util'
import { structuredRewindCut, type StructuredRewindCut } from './structured-rewind-cut'
import type { AgentSessionRewindRecord } from '../../../shared/agent-session-rewind'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
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
 * A Claude rewind from a build before rewinds forked never ran, so it is settled refused rather
 * than proven. Bookkeeping only: the chat is already attached either way.
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

type RecoveredRewind = Awaited<
  ReturnType<NonNullable<StructuredAgentSessionAdapter['recoverRewind']>>
>

/** What the provider says about a rewind in doubt, read with no journal or record write, so a
 *  caller can read it outside the session's serialize and apply it inside. Null: none in doubt. */
export type StructuredRewindRecoveryEvidence = {
  rewind: AgentSessionRewindRecord
  turns?: { beforeTurnId: string; keptTurnId: string | null }
  recovered?: RecoveredRewind
} | null

// Only this rewind moves a chat to a new epoch once it has history (imports run at creation), so
// a moved epoch is its own replacement, committed before the crash.
function rewindJournalCut(
  record: AgentSessionRecord | null,
  journal: AgentSessionJournal,
  rewind: AgentSessionRewindRecord
): { alreadyReplaced: boolean; cut: StructuredRewindCut | null } {
  const alreadyReplaced = journal.cursor().epoch !== rewind.expectedEpoch
  const head = record && agentSessionProviderHandleChainHead(record.providerHandleChain)?.handle
  const cut =
    alreadyReplaced || !record || !head
      ? null
      : structuredRewindCut(journal, {
          itemId: rewind.itemId,
          provider: record.provider,
          nativeId: head.nativeId
        })
  return { alreadyReplaced, cut }
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
  const evidence = await readStructuredRewindRecovery(
    deps,
    sessionId,
    journal,
    fence,
    adapter,
    signal
  )
  signal?.throwIfAborted()
  await applyStructuredRewindRecovery(deps, sessionId, journal, fence, evidence, receipt)
}

/** `record` is the one the apply will see, when a caller's commit before it changes the record. */
export async function readStructuredRewindRecovery(
  { store }: RewindRecoveryDeps,
  sessionId: string,
  journal: AgentSessionJournal,
  fence: number,
  adapter?: StructuredAgentSessionAdapter,
  signal?: AbortSignal,
  record = store.getRecord(sessionId)
): Promise<StructuredRewindRecoveryEvidence> {
  signal?.throwIfAborted()
  const rewind = record?.rewind
  if (rewind?.phase !== 'provider-succeeded' && rewind?.phase !== 'prepared') {
    return null
  }
  const target = parseAgentJournalItemKey(rewind.providerItemId ?? rewind.itemId)
  const { cut } = rewindJournalCut(record, journal, rewind)
  if (
    target?.provider === 'claude' ||
    rewind.phase !== 'prepared' ||
    !cut ||
    !('beforeTurnId' in cut)
  ) {
    return { rewind }
  }
  const turns = { beforeTurnId: cut.beforeTurnId, keptTurnId: cut.keptTurnId }
  const read = adapter?.recoverRewind?.({
    sessionId,
    fence,
    ...turns,
    ...(signal ? { signal } : {})
  })
  const recovered = signal
    ? await waitForPromiseWithSignal(Promise.resolve(read), signal)
    : await read
  return recovered ? { rewind, turns, recovered } : { rewind, turns }
}

/** The journal and record writes the evidence proves; a rewind or cut that moved since the read
 *  is not this evidence's to settle. */
export async function applyStructuredRewindRecovery(
  deps: RewindRecoveryDeps,
  sessionId: string,
  journal: AgentSessionJournal,
  fence: number,
  evidence: StructuredRewindRecoveryEvidence,
  receipt?: (
    rewind: AgentSessionRewindRecord,
    fence: number,
    cursor: AgentJournalCursor
  ) => JournalOperationReceipt
): Promise<void> {
  const { store } = deps
  let rewind = store.getRecord(sessionId)?.rewind
  if (!evidence || (rewind?.phase !== 'provider-succeeded' && rewind?.phase !== 'prepared')) {
    return
  }
  if (!isDeepStrictEqual(rewind, evidence.rewind)) {
    throw new Error('agent_session_rewind:stale-evidence')
  }
  const target = parseAgentJournalItemKey(rewind.providerItemId ?? rewind.itemId)
  if (target?.provider === 'claude' && !rewind.providerFork) {
    await settleUnsupportedClaudeRewind(deps, sessionId, fence, rewind)
    return
  }
  const { alreadyReplaced, cut } = rewindJournalCut(store.getRecord(sessionId), journal, rewind)
  if (!alreadyReplaced && !cut) {
    throw new Error('agent_session_rewind:invalid-target')
  }
  if (rewind.phase === 'prepared' && rewind.providerFork) {
    // New forks are durable already; older records leave the copy to their next launch.
    rewind = { ...rewind, phase: 'provider-succeeded' }
    await persistRewindRecord(store, sessionId, fence, rewind)
  } else if (rewind.phase === 'prepared') {
    if (!cut || !('beforeTurnId' in cut)) {
      throw new Error('agent_session_rewind:outcome-unknown')
    }
    if (
      evidence.turns?.beforeTurnId !== cut.beforeTurnId ||
      evidence.turns.keptTurnId !== cut.keptTurnId
    ) {
      throw new Error('agent_session_rewind:stale-evidence')
    }
    const { recovered } = evidence
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
  if (rewind.providerFork?.materialized && !rewind.contextClearOperationId && !alreadyReplaced) {
    const completed = rewind
    await journal.replaceEpochItems(
      'handle_forked',
      fence,
      cut!.kept,
      (cursor) =>
        receipt?.(completed, fence, cursor) ??
        store.conversationReceipts.rewind(sessionId, fence, completed, cursor)
    )
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
