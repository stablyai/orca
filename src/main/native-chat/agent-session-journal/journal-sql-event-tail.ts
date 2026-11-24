import { appendJournalRequestEvent } from './journal-writer-request-events'
import type Database from '../../sqlite/sync-database'
import type { JournalDomainEventChanges } from './journal-domain-schema'
import { invalidateJournalDomainQueue } from './journal-domain-queue-revision'

export const JOURNAL_EVENT_HISTORY_MS = 24 * 60 * 60 * 1000
const MAX_EVENT_SEQUENCES = 4096
const MAX_EVENT_BYTES = 16 * 1024

/** Metadata beyond the replay budget uses the existing snapshot reset, never truncates saved content. */
export function appendJournalSqlEvent(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  sequence: number,
  savedAt: number,
  changes: JournalDomainEventChanges,
  activity?: { fence: number; observedAt: number }
): void {
  const prefix = [target.sessionId, target.epoch] as const
  const json = JSON.stringify(changes)
  const oversized = Buffer.byteLength(json, 'utf8') > MAX_EVENT_BYTES
  if (changes.cards.length > 0 || changes.submissions.length > 0) {
    invalidateJournalDomainQueue(db, target, sequence)
  }
  db.prepare(`UPDATE journal_chat_state SET last_sequence=?, retained_sequence=MAX(retained_sequence,?),
    highest_fence=MAX(highest_fence,?), last_activity_at=MAX(last_activity_at,?)
    WHERE session_id=? AND epoch=?`).run(
    sequence,
    oversized ? sequence : Math.max(0, sequence - MAX_EVENT_SEQUENCES),
    activity?.fence ?? 0,
    activity?.observedAt ?? 0,
    ...prefix
  )
  db.prepare(`INSERT INTO journal_events(session_id,epoch,sequence,saved_at,changes_json)
    VALUES(?,?,?,?,?)`).run(
    ...prefix,
    sequence,
    savedAt,
    oversized ? '{"items":[],"submissions":[],"cards":[]}' : json
  )
  appendJournalRequestEvent(db, target, sequence)
  // One append creates at most one obsolete row; a reset can leave at most one bounded tail of debt.
  db.prepare(`DELETE FROM journal_events WHERE session_id=? AND epoch=? AND sequence IN (
    SELECT sequence FROM journal_events WHERE session_id=? AND epoch=?
    AND sequence<=(SELECT retained_sequence FROM journal_chat_state WHERE session_id=? AND epoch=?)
    ORDER BY sequence LIMIT 50
  )`).run(...prefix, ...prefix, ...prefix)
}

export type JournalSqlEventTailResult = {
  kind: 'event-tail'
  deleted: number
  more: boolean
}

/** Runs inside the writer transaction; replay metadata owns no bodies or receipt obligations. */
export function pruneJournalSqlEventTail(
  db: Database.Database,
  now: number
): JournalSqlEventTailResult {
  const expired = db
    .prepare(`SELECT session_id,epoch,sequence FROM journal_events
      WHERE saved_at<=? ORDER BY saved_at,session_id,epoch,sequence LIMIT 50`)
    .all(now - JOURNAL_EVENT_HISTORY_MS)
  const compact = db.prepare(`UPDATE journal_chat_state
    SET retained_sequence=MAX(retained_sequence,?) WHERE session_id=? AND epoch=?`)
  const remove = db.prepare(
    'DELETE FROM journal_events WHERE session_id=? AND epoch=? AND sequence=?'
  )
  for (const row of expired) {
    // Advance through any deleted hole even if the wall clock made saved_at nonmonotonic.
    compact.run(row.sequence, row.session_id, row.epoch)
    remove.run(row.session_id, row.epoch, row.sequence)
  }
  return {
    kind: 'event-tail',
    deleted: expired.length,
    more: expired.length === 50
  }
}
