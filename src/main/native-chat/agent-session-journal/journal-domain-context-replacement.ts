import type Database from '../../sqlite/sync-database'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  agentJournalLinkageFields,
  isRootAgentJournalItem
} from '../../../shared/agent-session/journal/agent-session-journal-producer'
import type {
  AgentJournalAcceptanceReceipt,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import type { AgentJournalEpochReason } from './durable-rows/journal-row-schema'
import { journalContextEpoch } from './context-epochs/journal-context-cursor'
import type { JournalReplacementItem } from './context-epochs/journal-epoch-replacement'
import { writeJournalDomainCurrentItem } from './journal-domain-current-item'
import { journalDomainEventItem, removeJournalDomainItem } from './journal-domain-item-removal'
import type { JournalSqlAcceptedInputs } from './journal-sql-accepted-inputs'
import { appendJournalSqlEvent } from './journal-sql-event-tail'
import { JournalDerivedTurnScope } from './projection/journal-derived-turn-scope'
import { journalItemRevisionValue } from './projection/journal-item-fold'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import { assertJournalFence } from './writing/journal-write-guards'
import {
  queueClearRestatement,
  writeJournalDomainQueueClear,
  type JournalDomainQueueClear
} from './journal-domain-queue-clear'
import { restoreRetainedFailures, retainedFailures } from './journal-domain-retained-failures'

type Target = { sessionId: string; epoch: string }

export type JournalDomainContextReplacement =
  | {
      kind: 'context-rewind'
      floor: AgentJournalCursor
      fence: number
      items: readonly JournalReplacementItem[]
    }
  | {
      kind: 'epoch-replace'
      reason: AgentJournalEpochReason
      fence: number
      items: readonly JournalReplacementItem[]
    }

export type JournalDomainContextCoordinate = {
  kind: 'context-item' | 'context-removal' | 'replacement-item' | 'queue-clear'
  cursor: AgentJournalCursor
  fence: number
  observedAt: number
}

export type JournalDomainContextCommit = {
  /** Public context identity at the last position, as the conversation receipt binds it. */
  cursor: AgentJournalCursor
  physicalCursor: AgentJournalCursor
  /** Set only when this command started a new context in the same physical epoch. */
  contextBoundary: number | null
  coordinates: JournalDomainContextCoordinate[]
  items: AgentJournalRenderItem[]
  removedItemIds: string[]
  /** Turns this command removed; membership persists independently of their items. */
  removedTurnIds: string[]
  cards: QueuedMessageRow[]
  clear: JournalDomainQueueClear | null
  receipts: AgentJournalAcceptanceReceipt[]
  inputChanged: boolean
  acceptedInputs?: JournalSqlAcceptedInputs
  editDeadline?: number | null
}

export function readJournalDomainContextHead(db: Database.Database, target: Target) {
  const head = db
    .prepare(`SELECT last_sequence, highest_fence, context_boundary, queue_clear_operation_id,
      queue_failure_boundary FROM journal_chat_state WHERE session_id=? AND epoch=?`)
    .get(target.sessionId, target.epoch)
  if (!head) {
    throw new Error('journal context command targets a retired chat epoch')
  }
  return {
    lastSequence: Number(head.last_sequence),
    highestFence: Number(head.highest_fence),
    contextBoundary: Number(head.context_boundary),
    cleared: head.queue_clear_operation_id !== null,
    failureBoundary: Number(head.queue_failure_boundary)
  }
}

export function replaceJournalDomainContext(
  db: Database.Database,
  target: Target,
  operation: JournalDomainContextReplacement,
  savedAt: number
): JournalDomainContextCommit {
  const prefix = [target.sessionId, target.epoch] as const
  const head = readJournalDomainContextHead(db, target)
  const floor = operation.kind === 'context-rewind' ? operation.floor : null
  if (
    floor &&
    (journalContextEpoch(target.epoch, head.contextBoundary) !== floor.epoch || !head.cleared)
  ) {
    throw new Error('agent_session_rewind:stale-context')
  }
  assertJournalFence(operation.fence, head.highestFence)
  const { fence } = operation
  const itemIds = operation.items.map((item) => agentJournalItemKey(item.identity))
  const current = db.prepare(`SELECT payload_json, ordinal, hidden, sequence, owner_fence,
    execution_owner FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?`)
  for (const itemId of itemIds) {
    const existing = current.get(...prefix, itemId)
    if (floor && existing && Number(existing.sequence) <= floor.sequence) {
      throw new Error('agent_session_rewind:proof-mismatch')
    }
  }
  const restatement = head.cleared ? queueClearRestatement(db, target) : null
  const retained = retainedFailures(db, target, itemIds, head.failureBoundary)
  const removalSequence = head.lastSequence + 1
  const coordinate = (
    kind: JournalDomainContextCoordinate['kind'],
    at: number
  ): JournalDomainContextCoordinate => ({
    kind,
    cursor: { epoch: target.epoch, sequence: at },
    fence,
    observedAt: savedAt
  })
  const commit: JournalDomainContextCommit = {
    cursor: { epoch: '', sequence: removalSequence },
    physicalCursor: { epoch: target.epoch, sequence: removalSequence },
    contextBoundary: null,
    coordinates: [coordinate('context-removal', removalSequence)],
    items: [],
    removedItemIds: [],
    removedTurnIds: [],
    cards: [],
    clear: null,
    receipts: [],
    inputChanged: true
  }
  const revisions = new Map<string, number>()
  const after = db
    .prepare(`SELECT item_id FROM journal_items WHERE session_id=? AND epoch=? AND sequence>?
      ORDER BY sequence, sequence_index, ordinal`)
    .all(...prefix, floor?.sequence ?? 0)
    .map((row) => String(row.item_id))
  for (const itemId of after) {
    if (queuedJournalDomainSubmission(db, target, itemId)) {
      continue
    }
    const removal = removeJournalDomainItem(db, target, itemId, removalSequence, revisions)
    commit.removedItemIds.push(removal.itemId)
    commit.items.push(...removal.items)
    const turnId = removal.removed?.body.kind === 'turn' ? removal.removed.body.turnId : undefined
    if (turnId !== undefined) {
      commit.removedTurnIds.push(turnId)
    }
  }
  if (operation.kind === 'epoch-replace') {
    // A new context in the same physical epoch: its public identity changes, its rows do not move.
    db.prepare(`UPDATE journal_chat_state SET context_boundary=?, derived_turn_item_id=NULL
      WHERE session_id=? AND epoch=?`).run(removalSequence, ...prefix)
    commit.contextBoundary = removalSequence
  }
  appendJournalSqlEvent(
    db,
    target,
    removalSequence,
    savedAt,
    {
      items: commit.items.map(journalDomainEventItem),
      submissions: [],
      cards: [],
      ...(commit.removedItemIds.length ? { removedItemIds: commit.removedItemIds } : {})
    },
    { fence, observedAt: savedAt }
  )
  // Replacement history derives absent scopes from its own order, not the removed suffix.
  const scope = new JournalDerivedTurnScope()
  let sequence = removalSequence
  const alias = db.prepare(`SELECT echo_declared FROM journal_item_aliases
    WHERE session_id=? AND epoch=? AND provider_item_id=?`)
  for (const [index, item] of operation.items.entries()) {
    sequence += 1
    const itemId = itemIds[index]!
    const stored = current.get(...prefix, itemId)
    const previous: AgentJournalRenderItem | undefined = stored
      ? JSON.parse(String(stored.payload_json))
      : undefined
    const tombstone = db
      .prepare(
        'SELECT revision FROM journal_item_tombstones WHERE session_id=? AND epoch=? AND item_id=?'
      )
      .get(...prefix, itemId)
    const revision =
      Math.max(
        revisions.get(itemId) ?? 0,
        Number(tombstone?.revision ?? 0),
        previous?.revision ?? 0
      ) + 1
    revisions.set(itemId, revision)
    const turnScope = item.turnScope ?? scope.scopeFor(item.body)
    scope.observe(itemId, isRootAgentJournalItem(item), undefined, item.body)
    const rendered: AgentJournalRenderItem = {
      itemId,
      revision,
      body: item.body,
      sequence,
      observedAt: item.observedAt ?? savedAt,
      turnScope,
      ...agentJournalLinkageFields(item)
    }
    const written = writeJournalDomainCurrentItem(db, target, {
      item: previous ? journalItemRevisionValue(previous, rendered) : rendered,
      ...(previous
        ? {
            previous: {
              item: previous,
              ordinal: Number(stored!.ordinal),
              hidden: Boolean(stored!.hidden)
            }
          }
        : {}),
      ordinal: stored ? Number(stored.ordinal) : sequence,
      hidden: Boolean(stored?.hidden),
      writtenSequence: sequence,
      ownerFence: item.ownerFence,
      executionOwner: item.executionOwner ?? null
    })
    if (tombstone) {
      db.prepare(
        'DELETE FROM journal_item_tombstones WHERE session_id=? AND epoch=? AND item_id=?'
      ).run(...prefix, itemId)
    }
    if (Object.hasOwn(item, 'echoOf') && !alias.get(...prefix, itemId)?.echo_declared) {
      db.prepare(`INSERT INTO journal_item_aliases(session_id,epoch,provider_item_id,item_id,echo_declared,echo_json)
        VALUES(?,?,?,?,1,?) ON CONFLICT(session_id,epoch,provider_item_id)
        DO UPDATE SET echo_declared=1, echo_json=excluded.echo_json`).run(
        ...prefix,
        itemId,
        itemId,
        JSON.stringify(item.echoOf ?? null)
      )
    }
    commit.items.push(...written)
    commit.coordinates.push(coordinate('replacement-item', sequence))
    appendJournalSqlEvent(
      db,
      target,
      sequence,
      savedAt,
      { items: written.map(journalDomainEventItem), submissions: [], cards: [] },
      { fence, observedAt: savedAt }
    )
  }
  restoreRetainedFailures(db, target, retained)
  if (restatement) {
    sequence += 1
    commit.clear = writeJournalDomainQueueClear(db, target, sequence, restatement)
    commit.coordinates.push(coordinate('queue-clear', sequence))
    appendJournalSqlEvent(
      db,
      target,
      sequence,
      savedAt,
      { items: [], submissions: [], cards: commit.clear.messageIds },
      { fence, observedAt: savedAt }
    )
  }
  commit.physicalCursor = { epoch: target.epoch, sequence }
  commit.cursor = journalDomainPublicCursor(db, target, sequence)
  return commit
}

export function journalDomainPublicCursor(
  db: Database.Database,
  target: Target,
  sequence: number
): AgentJournalCursor {
  return {
    epoch: journalContextEpoch(
      target.epoch,
      readJournalDomainContextHead(db, target).contextBoundary
    ),
    sequence
  }
}

/** Queued sends survive the rewind; their own handover still owns their placement. */
function queuedJournalDomainSubmission(
  db: Database.Database,
  target: Target,
  itemId: string
): boolean {
  const identity = parseAgentJournalItemKey(itemId)
  if (identity?.provider !== 'orca') {
    return false
  }
  const row = db
    .prepare(`SELECT payload_json FROM journal_submission_attempts
    WHERE session_id=? AND epoch=? AND message_id=? AND current=1`)
    .get(target.sessionId, target.epoch, identity.clientMessageId)
  return row !== undefined && isQueuedAgentJournalSubmission(JSON.parse(String(row.payload_json)))
}
