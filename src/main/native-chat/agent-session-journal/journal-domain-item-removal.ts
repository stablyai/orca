import { beforeJournalRequestWrite } from './journal-writer-request-events'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import type Database from '../../sqlite/sync-database'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { refreshJournalDomainStopNotes } from './journal-domain-stop-notes'
import { refreshJournalDomainQueueFailureReports } from './journal-domain-queue-failures'
import { observeJournalDomainTurnScope } from './journal-domain-turn-scope'
import { appendJournalSqlEvent } from './journal-sql-event-tail'
import { assertJournalFence } from './writing/journal-write-guards'
import { invalidateJournalDomainQueue } from './journal-domain-queue-revision'

type Target = { sessionId: string; epoch: string }

export type JournalDomainItemRemoval = {
  itemId: string
  revision: number
  /** The removed current body, when the item was current; its originals stay on their own rows. */
  removed: AgentJournalRenderItem | null
  /** Dependent Stop notes whose display this removal restored. */
  items: AgentJournalRenderItem[]
}

/** Deletes the current row, keeps a higher tombstone revision and every independent original:
 *  attempts, receipts, aliases, queue rows and removed-turn membership. */
export function removeJournalDomainItem(
  db: Database.Database,
  target: Target,
  key: string,
  sequence: number,
  revisions?: Map<string, number>,
  includeBody = true
): JournalDomainItemRemoval {
  if (!db.isTransaction) {
    throw new Error('journal item removal requires its writer transaction')
  }
  const prefix = [target.sessionId, target.epoch] as const
  const alias = db
    .prepare(`SELECT item_id FROM journal_item_aliases
    WHERE session_id=? AND epoch=? AND provider_item_id=?`)
    .get(...prefix, key)
  const itemId = alias ? String(alias.item_id) : key
  const row = db
    .prepare(`SELECT CASE WHEN ? OR turn_id IS NOT NULL THEN payload_json END AS payload_json,
      revision, sequence, sequence_index, turn_marker,prompt,command_entry,kind,
      queue_failure_report_turn_item_id FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?`)
    .get(Number(includeBody), ...prefix, itemId)
  if (row?.turn_marker) {
    beforeJournalRequestWrite(db, target, 'turn', itemId)
  }
  const tombstone = db
    .prepare(
      'SELECT revision FROM journal_item_tombstones WHERE session_id=? AND epoch=? AND item_id=?'
    )
    .get(...prefix, itemId)
  const revision =
    (revisions?.get(itemId) ??
      Math.max(Number(row?.revision ?? 0), Number(tombstone?.revision ?? 0))) + 1
  revisions?.set(itemId, revision)
  db.prepare(`INSERT INTO journal_item_tombstones(session_id,epoch,item_id,revision) VALUES(?,?,?,?)
    ON CONFLICT(session_id,epoch,item_id) DO UPDATE SET revision=excluded.revision`).run(
    ...prefix,
    itemId,
    revision
  )
  if (!row) {
    return { itemId, revision, removed: null, items: [] }
  }
  const removed: AgentJournalRenderItem | null =
    row.payload_json === null ? null : JSON.parse(String(row.payload_json))
  if (
    row.turn_marker ||
    row.prompt ||
    row.kind === 'approval' ||
    row.kind === 'question' ||
    row.command_entry ||
    row.queue_failure_report_turn_item_id !== null
  ) {
    invalidateJournalDomainQueue(db, target, sequence)
  }
  if (row.turn_marker) {
    exposeJournalDomainFailureBoundary(
      db,
      target,
      { sequence: Number(row.sequence), sequenceIndex: Number(row.sequence_index) },
      itemId,
      sequence
    )
  }
  db.prepare('DELETE FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?').run(
    ...prefix,
    itemId
  )
  db.prepare(
    'DELETE FROM journal_item_subagent_names WHERE session_id=? AND epoch=? AND item_id=?'
  ).run(...prefix, itemId)
  observeJournalDomainTurnScope(db, target, itemId, removed ?? undefined, undefined)
  const turn = readAgentJournalTurn(removed?.body)
  if (turn) {
    db.prepare(`INSERT OR IGNORE INTO journal_removed_turns(session_id,epoch,turn_id)
      VALUES(?,?,?)`).run(...prefix, turn.turnId)
  }
  // A delete bypasses the shared item write, so it refreshes the reported command turn itself.
  if (row.queue_failure_report_turn_item_id !== null) {
    refreshJournalDomainQueueFailureReports(
      db,
      target,
      [String(row.queue_failure_report_turn_item_id)],
      sequence
    )
  }
  return {
    itemId,
    revision,
    removed,
    items: turn
      ? refreshJournalDomainStopNotes(
          db,
          target,
          [itemId],
          new Map([[itemId, removed ?? undefined]])
        )
      : []
  }
}

/** Removing a turn or clear at or after the newest ordinary one exposes the failure beneath it. */
function exposeJournalDomainFailureBoundary(
  db: Database.Database,
  target: Target,
  row: { sequence: number; sequenceIndex: number },
  itemId: string,
  sequence: number
): void {
  const anchor = db
    .prepare(`SELECT sequence, sequence_index, item_id FROM journal_items INDEXED BY journal_items_turn_marker
    WHERE session_id=? AND epoch=? AND hidden=0 AND turn_marker=1 AND queue_command_turn=0
    ORDER BY sequence DESC, sequence_index DESC, item_id DESC LIMIT 1`)
    .get(target.sessionId, target.epoch)
  const order = anchor
    ? row.sequence - Number(anchor.sequence) ||
      row.sequenceIndex - Number(anchor.sequence_index) ||
      itemId.localeCompare(String(anchor.item_id))
    : 0
  if (order >= 0) {
    db.prepare(`UPDATE journal_chat_state SET queue_failure_boundary=?
      WHERE session_id=? AND epoch=?`).run(sequence, target.sessionId, target.epoch)
  }
}

export type JournalDomainTombstoneOperation =
  | { kind: 'tombstone'; identity: AgentJournalItemIdentity; fence: number }
  | {
      kind: 'goal-withdraw'
      identity: AgentJournalItemIdentity
      fence: number
      /** Claims the host's live goal proof says no other goal still holds, read just before. */
      releasedUploads: readonly string[]
    }

export type JournalDomainTombstoneCommit = {
  cursor: { epoch: string; sequence: number }
  fence: number
  observedAt: number
  items: AgentJournalRenderItem[]
  removedItemIds: string[]
  releasedUploads: string[]
}

/** One named removal command and its one identity event; the caller owns the SAVEPOINT. */
export function applyJournalDomainTombstone(
  db: Database.Database,
  target: Target,
  operation: JournalDomainTombstoneOperation,
  savedAt: number
): JournalDomainTombstoneCommit {
  if (!db.isTransaction) {
    throw new Error('journal tombstone requires its writer transaction')
  }
  const head = db
    .prepare(`SELECT last_sequence, highest_fence FROM journal_chat_state
    WHERE session_id=? AND epoch=?`)
    .get(target.sessionId, target.epoch)
  if (!head) {
    throw new Error('journal tombstone targets a retired chat epoch')
  }
  assertJournalFence(operation.fence, Number(head.highest_fence))
  const sequence = Number(head.last_sequence) + 1
  const removal = removeJournalDomainItem(
    db,
    target,
    agentJournalItemKey(operation.identity),
    sequence
  )
  const releasedUploads = operation.kind === 'goal-withdraw' ? [...operation.releasedUploads] : []
  const release = db.prepare(
    'DELETE FROM agent_session_attachment_claims WHERE upload_id=? AND session_id=?'
  )
  for (const uploadId of releasedUploads) {
    release.run(uploadId, target.sessionId)
  }
  appendJournalSqlEvent(
    db,
    target,
    sequence,
    savedAt,
    {
      items: removal.items.map(journalDomainEventItem),
      submissions: [],
      cards: [],
      removedItemIds: [removal.itemId]
    },
    { fence: operation.fence, observedAt: savedAt }
  )
  return {
    cursor: { epoch: target.epoch, sequence },
    fence: operation.fence,
    observedAt: savedAt,
    items: removal.items,
    removedItemIds: [removal.itemId],
    releasedUploads
  }
}

export function journalDomainEventItem(item: AgentJournalRenderItem) {
  return {
    itemId: item.itemId,
    revision: item.revision,
    sequence: item.sequence,
    sequenceIndex: item.sequenceIndex ?? 0
  }
}

/** Queued sends survive the rewind; their own handover still owns their placement. */
export function queuedJournalDomainSubmission(
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
