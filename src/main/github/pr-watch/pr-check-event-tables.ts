import type Database from '../../sqlite/sync-database'
import type { CheckOutcome } from '../../../shared/source-control/checks/provider-check-summary'
import type { PRCheckContextState } from './pr-check-occurrence'
import { numberColumn, textColumn, textColumnValues } from './pr-watch-sqlite-columns'
import { PR_KEY_SQL } from './pr-watch-tables'

// Per-head check memory, pending heads, events and their delivery outbox (tables in pr-watch-tables).

export function readPRCheckContexts(
  db: Database.Database,
  prKey: string,
  headSha: string
): Map<string, PRCheckContextState> {
  const rows = db
    .prepare(
      'SELECT context, last_state, last_run_id, pending_seen FROM pr_check_contexts WHERE pr_key = ? AND head_sha = ?'
    )
    .all(prKey, headSha)
  const contexts = new Map<string, PRCheckContextState>()
  for (const row of rows) {
    const context = textColumn(row, 'context')
    if (context !== null) {
      contexts.set(context, {
        context,
        lastState: checkOutcome(textColumn(row, 'last_state')),
        lastRunId: textColumn(row, 'last_run_id'),
        pendingSeen: row.pending_seen === 1
      })
    }
  }
  return contexts
}

export function replacePRCheckContexts(
  db: Database.Database,
  prKey: string,
  headSha: string,
  contexts: readonly PRCheckContextState[]
): void {
  db.prepare('DELETE FROM pr_check_contexts WHERE pr_key = ? AND head_sha = ?').run(prKey, headSha)
  const insert = db.prepare(
    `INSERT INTO pr_check_contexts (pr_key, head_sha, context, last_state, last_run_id, pending_seen)
      VALUES (?, ?, ?, ?, ?, ?)`
  )
  for (const row of contexts) {
    insert.run(prKey, headSha, row.context, row.lastState, row.lastRunId, row.pendingSeen ? 1 : 0)
  }
}

export type PRPendingHead = {
  prKey: string
  headSha: string
  movedAt: number | null
  expiresAt: number | null
}

export function readPRPendingHeads(db: Database.Database, prKey?: string): PRPendingHead[] {
  const rows =
    prKey === undefined
      ? db.prepare('SELECT * FROM pr_pending_heads').all()
      : db.prepare('SELECT * FROM pr_pending_heads WHERE pr_key = ?').all(prKey)
  return rows.flatMap((row) => {
    const rowPRKey = textColumn(row, 'pr_key')
    const headSha = textColumn(row, 'head_sha')
    return rowPRKey === null || headSha === null
      ? []
      : [
          {
            prKey: rowPRKey,
            headSha,
            movedAt: numberColumn(row, 'moved_at'),
            expiresAt: numberColumn(row, 'expires_at')
          }
        ]
  })
}

/** A head that moves keeps a fixed deadline from the move; a restart never extends it. */
export function upsertPRPendingHead(
  db: Database.Database,
  head: { prKey: string; headSha: string; now: number; movedAt: number | null; ttlMs: number }
): void {
  db.prepare(
    `INSERT INTO pr_pending_heads (pr_key, head_sha, first_seen_at, moved_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (pr_key, head_sha) DO UPDATE SET
        moved_at = COALESCE(moved_at, excluded.moved_at),
        expires_at = COALESCE(expires_at, excluded.expires_at)`
  ).run(
    head.prKey,
    head.headSha,
    head.now,
    head.movedAt,
    head.movedAt === null ? null : head.movedAt + head.ttlMs
  )
}

/** The PR moved off these heads; each keeps its result for a fixed time from now. */
export function markPRPendingHeadsMoved(
  db: Database.Database,
  prKey: string,
  currentHeadSha: string,
  movedAt: number,
  ttlMs: number
): void {
  db.prepare(
    `UPDATE pr_pending_heads SET moved_at = ?, expires_at = ?
      WHERE pr_key = ? AND head_sha != ? AND moved_at IS NULL`
  ).run(movedAt, movedAt + ttlMs, prKey, currentHeadSha)
}

/** A merged or closed PR reports no earlier head. */
export function deletePRMovedHeads(db: Database.Database, prKey: string): void {
  db.prepare('DELETE FROM pr_pending_heads WHERE pr_key = ? AND moved_at IS NOT NULL').run(prKey)
}

/** One chat's debt, by the primary key's chat prefix; unrelated chats' history costs nothing. */
export function hasPRPendingDelivery(db: Database.Database, chatId: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM pr_event_deliveries WHERE chat_id = ? AND state = 'pending' LIMIT 1")
      .get(chatId) !== undefined
  )
}

export function readPRPendingDeliveryChatIds(db: Database.Database): string[] {
  return textColumnValues(
    db.prepare("SELECT DISTINCT chat_id FROM pr_event_deliveries WHERE state = 'pending'").all(),
    'chat_id'
  )
}

/** Drops a head; its context memory follows on the next prune unless it reported a line. */
export function deletePRPendingHead(db: Database.Database, prKey: string, headSha: string): void {
  db.prepare('DELETE FROM pr_pending_heads WHERE pr_key = ? AND head_sha = ?').run(prKey, headSha)
}

/** Context memory is kept for the current head, pending heads and every head that reported a line,
 *  so re-watching (after a restart, an end or a force-push back) never repeats one. */
export function prunePRCheckContexts(
  db: Database.Database,
  prKey: string,
  currentHeadSha: string | null
): void {
  db.prepare(
    `DELETE FROM pr_check_contexts WHERE pr_key = ? AND head_sha IS NOT ?
      AND head_sha NOT IN (SELECT head_sha FROM pr_pending_heads WHERE pr_key = ?)
      AND head_sha NOT IN (SELECT head_sha FROM pr_check_events WHERE pr_key = ?)`
  ).run(prKey, currentHeadSha, prKey, prKey)
}

/** An ended watch reads no earlier heads; its context memory stays until its last action goes. */
export function endPRWatchState(db: Database.Database, prKey: string): void {
  db.prepare('DELETE FROM pr_pending_heads WHERE pr_key = ?').run(prKey)
}

/** Moved heads past their fixed deadline; nothing holds them any longer. */
export function deleteExpiredPRPendingHeads(db: Database.Database, now: number): void {
  db.prepare('DELETE FROM pr_pending_heads WHERE expires_at IS NOT NULL AND expires_at <= ?').run(
    now
  )
}

/** Current-head rows of PRs no recent chat action holds. */
export function deleteInactiveCurrentPRHeads(
  db: Database.Database,
  activePRKeys: ReadonlySet<string>
): void {
  const inactive = textColumnValues(
    db.prepare('SELECT DISTINCT pr_key FROM pr_pending_heads WHERE moved_at IS NULL').all(),
    'pr_key'
  ).filter((prKey) => !activePRKeys.has(prKey))
  const retire = db.prepare('DELETE FROM pr_pending_heads WHERE pr_key = ? AND moved_at IS NULL')
  for (const prKey of inactive) {
    retire.run(prKey)
  }
}

/** Writes the event and one pending delivery per owning chat; the caller holds the transaction. */
export function insertPRCheckEvent(
  db: Database.Database,
  event: {
    prKey: string
    headSha: string
    verdict: 'failure' | 'success'
    observedAt: number
    isCurrentHead: boolean
  }
): { eventId: number; occurrence: number; chatIds: string[] } {
  const last = db
    .prepare(
      'SELECT COALESCE(MAX(occurrence), 0) AS last FROM pr_check_events WHERE pr_key = ? AND head_sha = ?'
    )
    .get(event.prKey, event.headSha)
  const occurrence = (last ? (numberColumn(last, 'last') ?? 0) : 0) + 1
  const eventId = Number(
    db
      .prepare(
        `INSERT INTO pr_check_events
          (pr_key, head_sha, occurrence, verdict, completed_at, observed_at, is_current_head)
          VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.prKey,
        event.headSha,
        occurrence,
        event.verdict,
        event.observedAt,
        event.observedAt,
        event.isCurrentHead ? 1 : 0
      ).lastInsertRowid
  )
  const chatIds = textColumnValues(
    db
      .prepare(
        `SELECT DISTINCT chat_id FROM pr_chat_actions WHERE ${PR_KEY_SQL} = ? AND observed_at <= ?`
      )
      .all(event.prKey, event.observedAt),
    'chat_id'
  )
  const deliver = db.prepare(
    "INSERT OR IGNORE INTO pr_event_deliveries (chat_id, event_id, state) VALUES (?, ?, 'pending')"
  )
  for (const chatId of chatIds) {
    deliver.run(chatId, eventId)
  }
  return { eventId, occurrence, chatIds }
}

export type PRPendingDelivery = {
  eventId: number
  prKey: string
  headSha: string
  occurrence: number
  verdict: 'failure' | 'success'
}

export function readOldestPRPendingDelivery(
  db: Database.Database,
  chatId: string
): PRPendingDelivery | null {
  const row = db
    .prepare(
      `SELECT e.id, e.pr_key, e.head_sha, e.occurrence, e.verdict FROM pr_event_deliveries d
        JOIN pr_check_events e ON e.id = d.event_id
        WHERE d.chat_id = ? AND d.state = 'pending' ORDER BY e.id LIMIT 1`
    )
    .get(chatId)
  const eventId = row ? numberColumn(row, 'id') : null
  const prKey = row ? textColumn(row, 'pr_key') : null
  const headSha = row ? textColumn(row, 'head_sha') : null
  const occurrence = row ? numberColumn(row, 'occurrence') : null
  const verdict = row ? textColumn(row, 'verdict') : null
  return eventId !== null &&
    prKey !== null &&
    headSha !== null &&
    occurrence !== null &&
    (verdict === 'failure' || verdict === 'success')
    ? { eventId, prKey, headSha, occurrence, verdict }
    : null
}

export function markPRDeliveryDelivered(
  db: Database.Database,
  chatId: string,
  eventId: number,
  itemId: string
): void {
  db.prepare(
    "UPDATE pr_event_deliveries SET state = 'delivered', item_id = ? WHERE chat_id = ? AND event_id = ?"
  ).run(itemId, chatId, eventId)
}

function checkOutcome(value: string | null): CheckOutcome | null {
  return value === 'passed' || value === 'failed' || value === 'pending' || value === 'neutral'
    ? value
    : null
}
