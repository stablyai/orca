import type Database from '../../sqlite/sync-database'
import type { AgentSessionHistoryResult } from '../../../shared/agent-session/agent-session-wire'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentSessionForwardHistory } from '../agent-session-wire/publication/history/agent-session-history-forward-page'
import type {
  HistoryReader,
  HistoryItemForm
} from '../agent-session-wire/publication/history/agent-session-history-page-bounds'
import type { QueuedImageHistoryPolicy } from '../agent-session-wire/publication/history/agent-session-queued-image-reader'
import type { JournalReadSince } from './journal-store-contracts'
import type { JournalOutcomeReadRow } from './replay/journal-read-row'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  readJournalDomainSourceHeaders,
  readJournalDomainSourceBody
} from './journal-domain-source-items'
import { JournalSqlScope } from './journal-sql-scope'
import { fittingJournalDomainEventCount } from './journal-domain-history-window'
import { readJournalDomainClientItems } from './journal-domain-item-presentation'
import { findSequenceGap, resolveJournalResume } from './replay/journal-cursor'
import type { JournalDomainEventChanges } from './journal-domain-schema'
import type { JournalDomainHistoryHead } from './journal-domain-history-page'

/** Select one ordered event window, then current rows for only its identities, in the caller's snapshot. */
export function readJournalDomainForwardHistory(
  db: Database.Database,
  head: JournalDomainHistoryHead,
  cursor: AgentJournalCursor | undefined,
  limit: number,
  reader: Pick<HistoryReader, 'form' | 'budgetBytes'>,
  latestTurn: AgentJournalRenderItem | null,
  readSnapshot: (ids: Set<string>, forms: Map<string, HistoryItemForm>) => AgentJournalSnapshot,
  reset: (
    reason: Extract<AgentSessionHistoryResult, { ok: false }>['reset']
  ) => AgentSessionHistoryResult,
  queuedImages?: QueuedImageHistoryPolicy
): AgentSessionHistoryResult {
  // One bounded identity read serves the size admission and the builder's lookahead.
  const links = queuedImages && new Map(queuedImages.links)
  const since = cursor && readJournalDomainEvents(db, head, cursor, limit + 1, links)
  const forms = new Map<string, HistoryItemForm>()
  const admitted =
    since?.ok && queuedImages === undefined
      ? fittingJournalDomainEventCount(
          db,
          head,
          since.rows.slice(0, limit),
          reader.budgetBytes,
          forms
        )
      : limit
  let materialized: AgentJournalSnapshot | undefined
  return readAgentSessionForwardHistory(
    {
      readSince: (after, count = limit + 1) =>
        since?.ok
          ? firstEvents(since, count)
          : (since ?? readJournalDomainEvents(db, head, after, count, links)),
      canonicalItemId: (itemId) => itemId,
      hasSubmission: () => false,
      reset
    },
    {
      sessionId: head.sessionId,
      cursor: head.cursor,
      items: latestTurn ? [latestTurn] : [],
      submissions: []
    },
    cursor,
    admitted,
    reader,
    (ids) => {
      materialized ??= readSnapshot(ids, forms)
      return {
        ...materialized,
        items: materialized.items.filter((item) => ids.has(item.itemId)),
        submissions: materialized.submissions.filter((send) =>
          ids.has(agentJournalSubmissionKey(send.clientMessageId))
        )
      }
    }
  )
}

function firstEvents(
  since: Extract<JournalReadSince, { ok: true }>,
  count: number
): JournalReadSince {
  return since.rows.length <= count
    ? since
    : { ...since, rows: since.rows.slice(0, count), through: since.rows[count - 1]!.seq }
}

/** Retained events start after the pruned-through cursor; a missing sequence resets, never pages partially. */
function readJournalDomainEvents(
  db: Database.Database,
  head: JournalDomainHistoryHead,
  cursor: AgentJournalCursor,
  limit: number,
  queueLinks?: Map<string, readonly string[]>
): JournalReadSince {
  const resume = resolveJournalResume(
    {
      epoch: head.cursor.epoch,
      lastSequence: head.cursor.sequence,
      oldestSequence: head.retainedSequence + 1
    },
    cursor
  )
  if (!resume.ok) {
    return resume
  }
  const stored = db
    .prepare(`SELECT sequence, changes_json FROM journal_events
      WHERE session_id=? AND epoch=? AND sequence>? ORDER BY sequence LIMIT ?`)
    .all(head.sessionId, head.epoch, resume.afterSequence, limit)
  const complete = stored.length < limit
  const sequences = stored.map((row) => Number(row.sequence))
  if (
    findSequenceGap(sequences, resume.afterSequence + 1) ||
    (complete && (sequences.at(-1) ?? resume.afterSequence) !== head.cursor.sequence)
  ) {
    return { ok: false, reset: 'journal_gap' }
  }
  const rows: JournalOutcomeReadRow[] = []
  for (const row of stored) {
    const changes = eventChanges(String(row.changes_json))
    if (!changes) {
      return { ok: false, reset: 'schema_unreadable' }
    }
    rows.push({
      kind: 'outcome',
      epoch: head.cursor.epoch,
      seq: Number(row.sequence),
      itemIds: [
        ...changes.items.map((item) => item.itemId),
        ...(changes.removedItemIds ?? []),
        ...(queueLinks ? changedQueueSourceKeys(db, head, changes.cards, queueLinks) : [])
      ],
      submissionIds: changes.submissions
    })
  }
  return {
    ok: true,
    rows,
    through: complete ? head.cursor.sequence : sequences.at(-1)!,
    cursor: head.cursor
  }
}

function changedQueueSourceKeys(
  db: Database.Database,
  head: JournalDomainHistoryHead,
  cards: readonly string[],
  links: Map<string, readonly string[]>
): string[] {
  return cards.flatMap((id) => {
    const known = links.get(id)
    if (known) {
      return known.map(agentJournalSubmissionKey)
    }
    const row = db
      .prepare(`SELECT json_extract(payload_json,'$.recovers') AS recovers,
      json_extract(payload_json,'$.consumedAs') AS consumed_as FROM journal_queue_cards
      WHERE session_id=? AND epoch=? AND message_id=?`)
      .get(head.sessionId, head.epoch, id)
    const keys = [id, row?.recovers, row?.consumed_as].filter(
      (value): value is string => typeof value === 'string'
    )
    links.set(id, keys)
    return keys.map(agentJournalSubmissionKey)
  })
}

function eventChanges(json: string): JournalDomainEventChanges | null {
  let changes: JournalDomainEventChanges
  try {
    changes = JSON.parse(json)
  } catch {
    return null
  }
  const ids = (value: unknown) =>
    Array.isArray(value) && value.every((id) => typeof id === 'string')
  return Array.isArray(changes?.items) &&
    changes.items.every((item) => typeof item?.itemId === 'string') &&
    ids(changes.submissions) &&
    (changes.removedItemIds === undefined || ids(changes.removedItemIds))
    ? changes
    : null
}

/** Current attempts only, in submission order then stable admission ordinal. */
export function itemSubmissions(
  db: Database.Database,
  head: JournalDomainHistoryHead,
  itemIds: readonly string[],
  present: (send: AgentJournalSubmission) => AgentJournalSubmission = (send) => send,
  ordinals?: Map<string, number>,
  byItem?: Map<string, AgentJournalSubmission[]>
): AgentJournalSubmission[] {
  return db
    .prepare(`SELECT attempt.payload_json, attempt.ordinal, attempt.item_id FROM json_each(?) wanted
      CROSS JOIN journal_submission_attempts attempt
      WHERE attempt.session_id=? AND attempt.epoch=? AND attempt.current=1 AND attempt.item_id=wanted.value
      ORDER BY attempt.submitted_at, attempt.ordinal`)
    .all(JSON.stringify(itemIds), head.sessionId, head.epoch)
    .map((row) => {
      const send = present(JSON.parse(String(row.payload_json)))
      ordinals?.set(send.clientMessageId, Number(row.ordinal))
      if (byItem) {
        const group = byItem.get(String(row.item_id)) ?? []
        group.push(send)
        byItem.set(String(row.item_id), group)
      }
      return send
    })
}

export function readJournalDomainHistorySnapshot(
  db: Database.Database,
  head: JournalDomainHistoryHead,
  ids: ReadonlySet<string>,
  sourceIds: readonly string[] = [],
  present?: (send: AgentJournalSubmission) => AgentJournalSubmission,
  forms?: Map<string, HistoryItemForm>
): AgentJournalSnapshot {
  const wanted = [...ids]
  return {
    sessionId: head.sessionId,
    cursor: head.cursor,
    items: [
      ...readJournalDomainClientItems(
        db,
        head,
        db
          .prepare(`SELECT item.item_id FROM json_each(?) wanted
        CROSS JOIN journal_items item WHERE item.session_id=? AND item.epoch=? AND item.item_id=wanted.value AND item.hidden=0
        ORDER BY item.sequence,item.sequence_index,item.ordinal`)
          .all(JSON.stringify(wanted), head.sessionId, head.epoch)
          .map((row) => String(row.item_id)),
        forms
      ),
      ...readJournalDomainSourceHeaders(
        new JournalSqlScope(db, head.sessionId, head.epoch),
        sourceIds.filter((id) => ids.has(agentJournalSubmissionKey(id)))
      )
        .toReversed()
        .map((header) =>
          readJournalDomainSourceBody(new JournalSqlScope(db, head.sessionId, head.epoch), header)
        )
    ],
    submissions: itemSubmissions(db, head, wanted, present)
  }
}

export function latestTurnItem(
  db: Database.Database,
  head: JournalDomainHistoryHead
): AgentJournalRenderItem | null {
  const row = db
    .prepare(`SELECT item_id FROM journal_items item WHERE session_id=? AND epoch=? AND hidden=0
      AND turn_marker=1 ORDER BY sequence DESC, sequence_index DESC, ordinal DESC LIMIT 1`)
    .get(head.sessionId, head.epoch)
  return row ? (readJournalDomainClientItems(db, head, [String(row.item_id)])[0] ?? null) : null
}
