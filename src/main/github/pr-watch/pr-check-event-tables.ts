import type Database from '../../sqlite/sync-database'
import type { CheckOutcome } from '../../../shared/source-control/checks/provider-check-summary'
import type { PRCheckContextState } from './pr-check-occurrence'
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
    .all(prKey, headSha) as {
    context: string
    last_state: CheckOutcome | null
    last_run_id: string | null
    pending_seen: number
  }[]
  return new Map(
    rows.map((row) => [
      row.context,
      {
        context: row.context,
        lastState: row.last_state,
        lastRunId: row.last_run_id,
        pendingSeen: row.pending_seen === 1
      }
    ])
  )
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
  const rows = (
    prKey === undefined
      ? db.prepare('SELECT * FROM pr_pending_heads').all()
      : db.prepare('SELECT * FROM pr_pending_heads WHERE pr_key = ?').all(prKey)
  ) as { pr_key: string; head_sha: string; moved_at: number | null; expires_at: number | null }[]
  return rows.map((row) => ({
    prKey: row.pr_key,
    headSha: row.head_sha,
    movedAt: row.moved_at,
    expiresAt: row.expires_at
  }))
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

export function readPRPendingDeliveryChatIds(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT DISTINCT chat_id FROM pr_event_deliveries WHERE state = 'pending'")
      .all() as { chat_id: string }[]
  ).map((row) => row.chat_id)
}

/** Drops a head; its context memory goes with it on the next prune. */
export function deletePRPendingHead(db: Database.Database, prKey: string, headSha: string): void {
  db.prepare('DELETE FROM pr_pending_heads WHERE pr_key = ? AND head_sha = ?').run(prKey, headSha)
}

/** Context memory is kept only for the PR's current head and the heads still pending. */
export function prunePRCheckContexts(
  db: Database.Database,
  prKey: string,
  currentHeadSha: string | null
): void {
  db.prepare(
    `DELETE FROM pr_check_contexts WHERE pr_key = ? AND head_sha IS NOT ?
      AND head_sha NOT IN (SELECT head_sha FROM pr_pending_heads WHERE pr_key = ?)`
  ).run(prKey, currentHeadSha, prKey)
}

/** Ends everything kept for a PR except its actions, which live as long as their chats. */
export function endPRWatchState(db: Database.Database, prKey: string): void {
  db.prepare('DELETE FROM pr_pending_heads WHERE pr_key = ?').run(prKey)
  db.prepare('DELETE FROM pr_check_contexts WHERE pr_key = ?').run(prKey)
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
  const { last } = db
    .prepare(
      'SELECT COALESCE(MAX(occurrence), 0) AS last FROM pr_check_events WHERE pr_key = ? AND head_sha = ?'
    )
    .get(event.prKey, event.headSha) as { last: number }
  const occurrence = last + 1
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
  const chatIds = (
    db
      .prepare(
        `SELECT DISTINCT chat_id FROM pr_chat_actions WHERE ${PR_KEY_SQL} = ? AND observed_at <= ?`
      )
      .all(event.prKey, event.observedAt) as { chat_id: string }[]
  ).map((row) => row.chat_id)
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
    .get(chatId) as
    | {
        id: number
        pr_key: string
        head_sha: string
        occurrence: number
        verdict: 'failure' | 'success'
      }
    | undefined
  return row
    ? {
        eventId: row.id,
        prKey: row.pr_key,
        headSha: row.head_sha,
        occurrence: row.occurrence,
        verdict: row.verdict
      }
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
