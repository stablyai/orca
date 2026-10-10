import {
  mergeRetainedHostLifecycleRows,
  retainedRowReplacement
} from './structured-rewind-retained-host-rows'
import { isDeepStrictEqual } from 'node:util'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionRewindRecord } from '../../../shared/agent-session-rewind'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { AGENT_SESSION_HISTORY_MAX_PAGE_BYTES } from './agent-session-history-page-bounds'
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
  return store.transitionHandoff(sessionId, (record) => {
    if (record.lease.runtimeFence !== fence) {
      throw new Error('agent_session_checkpoint_stale')
    }
    return { ...record, rewind }
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
      reason: 'unsupported',
      retained: []
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
  now: () => number = Date.now,
  receipt?: (
    rewind: AgentSessionRewindRecord,
    fence: number,
    cursor: AgentJournalCursor
  ) => JournalOperationReceipt
): Promise<void> {
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
  if (target?.provider === 'codex' && !rewind.hydrationVerified) {
    const recovered = await adapter?.recoverRewind?.({
      sessionId,
      fence,
      beforeTurnId: target.turnId
    })
    if (!recovered?.ok) {
      // The target is still in the provider's history, and the journal is replaced only once the
      // revert is proven, so both still hold it even when the provider acknowledged the revert.
      if (recovered?.reason === 'provider-refused' && rewind.phase === 'prepared') {
        await persistRewindRecord(store, sessionId, fence, {
          ...rewind,
          phase: 'refused',
          reason: recovered.reason,
          retained: []
        })
        return
      }
      throw new Error(`agent_session_rewind:${recovered?.reason ?? 'outcome-unknown'}`)
    }
    const expectedItems = new Set(
      rewind.retained
        .filter((item) => {
          const identity = parseAgentJournalItemKey(item.itemId)
          return identity?.provider === 'codex' && identity.threadId === target.threadId
        })
        .map((item) => item.itemId)
    )
    const observedItems = new Set<string>()
    for (const { identity } of recovered.items) {
      const itemId = agentJournalItemKey(identity)
      if (
        identity.provider !== 'codex' ||
        identity.threadId !== target.threadId ||
        !expectedItems.has(itemId)
      ) {
        throw new Error('agent_session_rewind:proof-mismatch')
      }
      observedItems.add(itemId)
    }
    if (observedItems.size !== expectedItems.size) {
      throw new Error('agent_session_rewind:proof-mismatch')
    }
    const retained = mergeRetainedHostLifecycleRows(
      rewind.retained,
      recovered.items.map(({ identity, body }) => ({
        itemId: agentJournalItemKey(identity),
        body,
        observedAt: now()
      }))
    )
    if (
      retained.length > 10_000 ||
      Buffer.byteLength(JSON.stringify(retained), 'utf8') > AGENT_SESSION_HISTORY_MAX_PAGE_BYTES
    ) {
      throw new Error('agent_session_rewind:history-limit')
    }
    rewind = { ...rewind, retained, phase: 'provider-succeeded', hydrationVerified: true }
    await persistRewindRecord(store, sessionId, fence, rewind)
  }
  if (rewind.phase !== 'provider-succeeded') {
    return
  }
  const replacement = rewind.retained.map(retainedRowReplacement)
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
      replacement,
      (cursor) =>
        receipt?.(completed, fence, cursor) ??
        store.conversationReceipts.rewind(sessionId, fence, completed, cursor)
    )
    return
  }
  // A crash after the journal transaction must settle its existing epoch, not replace it twice.
  const alreadyReplaced = journal.cursor().epoch !== rewind.expectedEpoch
  if (
    alreadyReplaced &&
    !isDeepStrictEqual(
      journal.snapshot().items.map(({ itemId }) => ({
        itemId,
        body: journal.itemBody(itemId)
      })),
      replacement.map(({ identity, body }) => ({ itemId: agentJournalItemKey(identity), body }))
    )
  ) {
    throw new Error('agent_session_rewind:stale-epoch')
  }
  const cursor = alreadyReplaced
    ? journal.cursor()
    : await journal.replaceEpochItems('handle_forked', fence, replacement)
  await persistRewindRecord(store, sessionId, fence, {
    ...rewind,
    phase: 'completed',
    epoch: cursor.epoch,
    retained: []
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
