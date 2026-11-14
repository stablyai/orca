import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { persistRewindRecord, settleUnsupportedClaudeRewind } from './structured-rewind-record'

import { structuredAgentSessionConversationFence } from '../host/structured-agent-session-provider-child'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from '../host/structured-agent-session-host-types'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import { parseAgentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isDeepStrictEqual } from 'node:util'
import { legacyRewindTurns, rewindJournalCut } from './structured-rewind-cut'
import type { AgentSessionRewindRecord } from '../../../../shared/agent-session/lifecycle/rewind/agent-session-rewind'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from '../providers/structured-agent-session-adapter'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'
import {
  onJournalReceiptCommitted,
  type JournalOperationReceipt
} from '../../agent-session-journal/writing/journal-row-writer'

export type RewindRecoveryDeps = {
  store: AgentSessionRecordStore
  logger: StructuredAgentSessionLogger
  nameProviderConversation?: (record: AgentSessionRecord) => void
}

type RecoveredRewind = Awaited<
  ReturnType<NonNullable<StructuredAgentSessionAdapter['recoverRewind']>>
>

/** Read provider evidence outside serialization; apply journal/record changes inside it. */
export type StructuredRewindRecoveryEvidence = {
  rewind: AgentSessionRewindRecord
  turns?: { beforeTurnId: string; keptTurnId: string | null; threadId?: string }
  recovered?: RecoveredRewind
} | null

/** Recovery observes provider state; it never repeats an ambiguous native mutation. */
export async function recoverStructuredRewind(
  deps: RewindRecoveryDeps,
  sessionId: string,
  journal: AgentSessionJournal,
  fence: number,
  adapter?: StructuredAgentSessionAdapter,
  receipt?: (rewind: AgentSessionRewindRecord, fence: number) => JournalOperationReceipt,
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

/** Supply the record a pending commit will expose to apply. */
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
  const { cut } = await rewindJournalCut(record, journal, rewind)
  if (
    target?.provider === 'claude' ||
    rewind.phase !== 'prepared' ||
    !cut ||
    !('beforeTurnId' in cut)
  ) {
    return { rewind }
  }
  const turns =
    rewind.providerRevert ??
    legacyRewindTurns(journal, cut, target?.provider === 'codex' ? target.threadId : '')!

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

/** Apply only while the saved rewind and cut still match the evidence. */
export async function applyStructuredRewindRecovery(
  deps: RewindRecoveryDeps,
  sessionId: string,
  journal: AgentSessionJournal,
  fence: number,
  evidence: StructuredRewindRecoveryEvidence,
  receipt?: (rewind: AgentSessionRewindRecord, fence: number) => JournalOperationReceipt
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
  const { alreadyReplaced, cut } = await rewindJournalCut(
    store.getRecord(sessionId),
    journal,
    rewind
  )
  if (!alreadyReplaced && !cut) {
    throw new Error('agent_session_rewind:invalid-target')
  }
  if (rewind.phase === 'prepared' && rewind.providerFork) {
    rewind = { ...rewind, phase: 'provider-succeeded' }
    await persistRewindRecord(store, sessionId, fence, rewind)
  } else if (rewind.phase === 'prepared') {
    if (!cut || !('beforeTurnId' in cut)) {
      throw new Error('agent_session_rewind:outcome-unknown')
    }
    if (
      !isDeepStrictEqual(
        evidence.turns,
        rewind.providerRevert ??
          legacyRewindTurns(journal, cut, target?.provider === 'codex' ? target.threadId : '')
      )
    ) {
      throw new Error('agent_session_rewind:stale-evidence')
    }
    const { recovered } = evidence
    if (!recovered?.ok) {
      // Keep both histories until revert is proven, even after provider acknowledgement.
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
  const completed = rewind
  const completion =
    receipt?.(completed, fence) ?? store.conversationReceipts.rewind(sessionId, fence, completed)
  await journal.completeRewind(
    completed,
    fence,
    cut,
    onJournalReceiptCommitted(completion, () => {
      const record = store.getRecord(sessionId)
      if (record?.rewind?.providerFork?.materialized) {
        deps.nameProviderConversation?.(record)
      }
    })
  )
}

/** Settle prepared rewinds orphaned across processes; provider-only proof waits for the next proven start. */
export async function settleInterruptedStructuredAgentSessionCommands(
  deps: StructuredAgentSessionHostDeps,
  sessionId: string,
  session: StructuredAgentSessionHostSession
): Promise<void> {
  const fence = structuredAgentSessionConversationFence(deps.store, sessionId)
  try {
    await recoverStructuredRewind(deps, sessionId, session.journal, fence)
  } catch (error) {
    deps.logger.warn('settling an interrupted rewind on open failed', {
      scope: 'rewind-recovery',
      sessionId,
      error
    })
  }
}
