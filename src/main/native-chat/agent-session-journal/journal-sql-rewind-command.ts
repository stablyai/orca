import { isDeepStrictEqual } from 'node:util'
import type Database from '../../sqlite/sync-database'
import { isReadableAgentSessionStoreRecord } from '../../runtime/agent-session/records/agent-session-store-row-rules'
import { decodePersistedAgentSessionRecord } from '../../../shared/agent-session/lifecycle/records/agent-session-record-stored-form'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import {
  agentSessionJournalProviderHandle,
  claudeProviderHandle
} from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { assertJournalFence } from './writing/journal-write-guards'
import type { JournalWriterCommand } from './journal-writer-command'
import { JournalSqlScope } from './journal-sql-scope'
import { planJournalDomainRewindCut } from './journal-domain-rewind-cut'
import {
  readJournalDomainContextHead,
  journalDomainPublicCursor
} from './journal-domain-context-replacement'
import { journalDomainEventItem } from './journal-domain-item-removal'
import { restoreRetainedFailures } from './journal-domain-retained-failures'
import { removeJournalDomainRewindSuffix } from './journal-domain-rewind-removal'
import { invalidateJournalDomainQueue } from './journal-domain-queue-revision'
import { queueClearRestatement, writeJournalDomainQueueClear } from './journal-domain-queue-clear'
import { appendJournalSqlEvent } from './journal-sql-event-tail'
import { finishJournalSqlCommand } from './journal-sql-command-result'
import type { JournalDomainContextCommit } from './journal-domain-context-command'
import {
  sameJournalConversation,
  usableJournalHistoryOrigin
} from './context-epochs/journal-history-origin'

/** The cut, remapped boundary and completion receipt share this writer transaction. */
export function applyJournalSqlRewindCommand(
  db: Database.Database,
  stateDirectory: string,
  command: JournalWriterCommand & {
    operation: Extract<JournalWriterCommand['operation'], { kind: 'rewind-cut' }>
  },
  savedAt: number
) {
  const { target, operation } = command
  if (!db.isTransaction) {
    throw new Error('rewind requires its writer transaction')
  }
  const { rewind, fence } = operation
  const prefix = [target.sessionId, target.epoch] as const
  const raw = db
    .prepare('SELECT record_json FROM agent_session_records WHERE session_id=?')
    .get(target.sessionId)
  const stored: unknown = raw && JSON.parse(String(raw.record_json))
  if (!isReadableAgentSessionStoreRecord(target.sessionId, stored)) {
    throw new Error('agent_session_rewind:record-unreadable')
  }
  const { record } = decodePersistedAgentSessionRecord(stored)
  if (
    !isDeepStrictEqual(record.rewind, rewind) ||
    rewind.phase !== 'provider-succeeded' ||
    record.lease.runtimeFence !== fence
  ) {
    throw new Error('agent_session_rewind:stale-evidence')
  }
  if (
    !command.effects?.some(
      (effect) =>
        effect.kind === 'store' &&
        effect.mutation.input.kind === 'rewind-complete' &&
        effect.mutation.input.sessionId === target.sessionId &&
        isDeepStrictEqual(effect.mutation.input.rewind, rewind)
    )
  ) {
    throw new Error('rewind requires its atomic completion receipt')
  }
  const head = readJournalDomainContextHead(db, target)
  assertJournalFence(fence, head.highestFence)
  const cursor = journalDomainPublicCursor(db, target, head.lastSequence)
  const commit: JournalDomainContextCommit = {
    cursor,
    physicalCursor: { epoch: target.epoch, sequence: head.lastSequence },
    contextBoundary: null,
    coordinates: [],
    items: [],
    removedItemIds: [],
    removedTurnIds: [],
    cards: [],
    receipts: [],
    clear: null,
    inputChanged: false
  }
  let childBoundary = record.forkedFrom?.childBoundary
  if (cursor.epoch === rewind.expectedEpoch) {
    const handle = agentSessionProviderHandleChainHead(record.providerHandleChain)?.handle
    const plan =
      handle &&
      planJournalDomainRewindCut(new JournalSqlScope(db, target.sessionId, target.epoch), {
        itemId: rewind.itemId,
        provider: record.provider,
        nativeId: handle.nativeId
      })
    if (!plan) {
      throw new Error('agent_session_rewind:invalid-target')
    }
    if (!isDeepStrictEqual(plan.cut, operation.expectedCut)) {
      throw new Error('agent_session_rewind:stale-evidence')
    }
    const local = rewind.contextClearOperationId !== undefined
    if (
      local &&
      (record.providerContextBoundary?.operationId !== rewind.contextClearOperationId ||
        plan.cut.floor !== rewind.contextClearSequence ||
        !head.cleared)
    ) {
      throw new Error('agent_session_rewind:stale-context')
    }
    const providerHandle = agentSessionJournalProviderHandle({
      agent: record.provider,
      providerHandle: rewind.providerFork
        ? claudeProviderHandle(
            rewind.providerFork.sessionId,
            rewind.providerFork.resumeCursor ?? null
          )
        : (handle ?? null)
    })
    const nativeOrigin =
      rewind.providerFork?.coverage !== undefined &&
      usableJournalHistoryOrigin(head.historyOrigin)?.kind === 'native_copy'
        ? {
            providerHandle,
            raw: {
              version: 1 as const,
              kind: 'native_copy' as const,
              agent: 'claude',
              unit: 'claude-entry' as const,
              providerHandle,
              ids: rewind.providerFork.coverage
            }
          }
        : undefined
    const floor = local ? plan.cut.floor : 0
    const restatement = head.cleared ? queueClearRestatement(db, target) : null
    let sequence = head.lastSequence + 1
    invalidateJournalDomainQueue(db, target, sequence)
    const removed = removeJournalDomainRewindSuffix(
      new JournalSqlScope(db, target.sessionId, target.epoch),
      plan.membership,
      floor,
      sequence,
      head.failureBoundary,
      childBoundary
    )
    childBoundary = removed.childBoundary
    commit.removedItemIds = removed.removedItemIds
    commit.removedTurnIds = removed.removedTurnIds
    commit.items = removed.items
    if (!local) {
      const providerHandle = agentSessionJournalProviderHandle({
        agent: record.provider,
        providerHandle: rewind.providerFork
          ? claudeProviderHandle(
              rewind.providerFork.sessionId,
              rewind.providerFork.resumeCursor ?? null
            )
          : (handle ?? null)
      })
      const origin =
        nativeOrigin ??
        (head.historyOrigin &&
        sameJournalConversation(head.historyOrigin.providerHandle, providerHandle)
          ? { ...head.historyOrigin, providerHandle }
          : null)
      db.prepare(
        `UPDATE journal_chat_state SET context_boundary=?,history_origin_json=? WHERE session_id=? AND epoch=?`
      ).run(sequence, origin ? JSON.stringify(origin) : null, ...prefix)
      commit.contextBoundary = sequence
    }
    if (local && nativeOrigin) {
      db.prepare(
        'UPDATE journal_chat_state SET history_origin_json=? WHERE session_id=? AND epoch=?'
      ).run(JSON.stringify(nativeOrigin), ...prefix)
    }
    const span = db
      .prepare(`SELECT item_id,context_clear FROM journal_items INDEXED BY journal_items_root_position
      WHERE session_id=? AND epoch=? AND hidden=0 AND root=1 AND sequence>?
      AND (turn_id IS NOT NULL OR context_clear=1) ORDER BY sequence DESC,sequence_index DESC,ordinal DESC LIMIT 1`)
      .get(...prefix, floor)
    db.prepare(
      'UPDATE journal_chat_state SET derived_turn_item_id=? WHERE session_id=? AND epoch=?'
    ).run(span && !span.context_clear ? String(span.item_id) : null, ...prefix)
    appendJournalSqlEvent(
      db,
      target,
      sequence,
      savedAt,
      {
        items: commit.items.map(journalDomainEventItem),
        submissions: [],
        cards: [],
        removedItemIds: commit.removedItemIds
      },
      { fence, observedAt: savedAt }
    )
    commit.coordinates.push({
      kind: 'context-removal',
      cursor: { epoch: target.epoch, sequence },
      fence,
      observedAt: savedAt
    })
    restoreRetainedFailures(db, target, removed.failures)
    if (restatement) {
      sequence++
      commit.clear = writeJournalDomainQueueClear(db, target, sequence, restatement)
      appendJournalSqlEvent(
        db,
        target,
        sequence,
        savedAt,
        { items: [], submissions: [], cards: commit.clear.messageIds },
        { fence, observedAt: savedAt }
      )
      commit.coordinates.push({
        kind: 'queue-clear',
        cursor: { epoch: target.epoch, sequence },
        fence,
        observedAt: savedAt
      })
    }
    commit.physicalCursor = { epoch: target.epoch, sequence }
    commit.cursor = journalDomainPublicCursor(db, target, sequence)
    commit.inputChanged = true
  } else if (rewind.contextClearOperationId) {
    throw new Error('agent_session_rewind:stale-context')
  }
  const effects = command.effects.map((effect) =>
    effect.kind === 'store' && effect.mutation.input.kind === 'rewind-complete'
      ? {
          ...effect,
          mutation: { ...effect.mutation, input: { ...effect.mutation.input, childBoundary } }
        }
      : effect
  )
  return finishJournalSqlCommand(
    db,
    stateDirectory,
    { ...command, effects },
    commit,
    commit.cursor,
    commit.coordinates.map((row) => ({
      kind: 'tombstone' as const,
      epoch: row.cursor.epoch,
      seq: row.cursor.sequence
    })),
    [...commit.removedItemIds, ...commit.items.map((item) => item.itemId)]
  )
}
