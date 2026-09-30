// The queue-level pause fact: where in the journal the user's last Stop (or a
// /clear, which starts its replacement paused) took effect. The pause itself is never stored — it is derived from this fact and
// the journal rows after it (a user-requested turn that started ends it); the
// fact only records the one event the journal's closed row kinds cannot carry.
// An explicit Resume retires it.

import type Database from '../../sqlite/sync-database'

export type QueuePauseReason = 'stopped' | 'cleared'

export type QueuePauseFact = {
  reason: QueuePauseReason
  /** The journal position the Stop took effect at: rows after it are later. */
  epoch: string
  sequence: number
  recordedAt: number
}

export function readQueuePause(db: Database.Database, sessionId: string): QueuePauseFact | null {
  const row: unknown = db
    .prepare(
      'SELECT reason, epoch, sequence, recorded_at FROM queued_message_pauses WHERE session_id = ?'
    )
    .get(sessionId)
  if (
    typeof row !== 'object' ||
    row === null ||
    !('reason' in row) ||
    (row.reason !== 'stopped' && row.reason !== 'cleared') ||
    !('epoch' in row) ||
    typeof row.epoch !== 'string' ||
    !('sequence' in row) ||
    typeof row.sequence !== 'number' ||
    !('recorded_at' in row) ||
    typeof row.recorded_at !== 'number'
  ) {
    // A reason this build cannot place reads as no pause rather than a wrong one.
    return null
  }
  return {
    reason: row.reason,
    epoch: row.epoch,
    sequence: row.sequence,
    recordedAt: row.recorded_at
  }
}

/** The latest Stop replaces an earlier one: only the last interruption decides. */
export function recordQueuePause(
  db: Database.Database,
  input: { sessionId: string; fact: QueuePauseFact }
): void {
  db.prepare(
    `INSERT INTO queued_message_pauses (session_id, reason, epoch, sequence, recorded_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET
       reason = excluded.reason, epoch = excluded.epoch,
       sequence = excluded.sequence, recorded_at = excluded.recorded_at`
  ).run(
    input.sessionId,
    input.fact.reason,
    input.fact.epoch,
    input.fact.sequence,
    input.fact.recordedAt
  )
}

/** Compare-and-clear: only the fact the caller judged, so a Stop recorded since stands. */
export function clearQueuePause(
  db: Database.Database,
  input: { sessionId: string; fact: Pick<QueuePauseFact, 'epoch' | 'sequence'> }
): number {
  return Number(
    db
      .prepare(
        'DELETE FROM queued_message_pauses WHERE session_id = ? AND epoch = ? AND sequence = ?'
      )
      .run(input.sessionId, input.fact.epoch, input.fact.sequence).changes ?? 0
  )
}

type QueueCardState = { state: string; holdReason: string | null }

/** A card a pause holds back: waiting, with no hold of its own, wherever it sits.
 *  While one exists — or a hand-off still owed a return to waiting
 *  (`queuePauseHoldsBack`) — the pause is KEPT: a Stop records it, and it is
 *  retired only once none remains, so deleting a returned card that blocks such
 *  cards leaves them paused rather than sending them unasked. */
export function isPausableQueuedMessage(row: QueueCardState): boolean {
  return row.state === 'waiting' && row.holdReason === null
}

/** Whether Resume would send anything: a pausable card not behind a returned one,
 *  which blocks everything after it until the user acts, exactly as the drain
 *  reads it. Only then is the kept pause PUBLISHED, so its header never offers a
 *  Resume that sends nothing. */
export function hasResumableQueuedMessage(rows: readonly QueueCardState[]): boolean {
  for (const row of rows) {
    if (row.state === 'returned') {
      return false
    }
    if (isPausableQueuedMessage(row)) {
      return true
    }
  }
  return false
}

/** What a queue pause holds back, judged inside the caller's transaction: a waiting
 *  card with no hold of its own (`isPausableQueuedMessage`, in SQL), or a dispatched
 *  one whose settlement back to waiting is still owed — its hook was skipped, so the
 *  row has not caught up with its rejected submission, which only the journal's
 *  submissions can tell (`owedToWaiting`). */
export function queuePauseHoldsBack(
  db: Database.Database,
  input: { sessionId: string; owedToWaiting: (consumedRef: string) => boolean }
): boolean {
  const pausable = db
    .prepare(
      `SELECT 1 FROM queued_messages
       WHERE session_id = ? AND state = 'waiting' AND hold_reason IS NULL LIMIT 1`
    )
    .get(input.sessionId)
  if (pausable !== undefined) {
    return true
  }
  return db
    .prepare(
      `SELECT consumed_as FROM queued_messages
       WHERE session_id = ? AND state = 'dispatched' AND consumed_as IS NOT NULL`
    )
    .all(input.sessionId)
    .some(
      (row) =>
        typeof row === 'object' &&
        row !== null &&
        'consumed_as' in row &&
        typeof row.consumed_as === 'string' &&
        input.owedToWaiting(row.consumed_as)
    )
}

/** A pause is over the cards it paused: once it holds back none (`queuePauseHoldsBack`),
 *  the fact goes too, in the same transaction as the write that took the last one, so
 *  it can never outlive them and catch a card typed long after. */
export function retireQueuePauseIfNothingHeld(
  db: Database.Database,
  input: { sessionId: string; owedToWaiting: (consumedRef: string) => boolean }
): number {
  // Runs on every appended journal row: with no pause recorded there is nothing to judge.
  const recorded = db
    .prepare('SELECT 1 FROM queued_message_pauses WHERE session_id = ?')
    .get(input.sessionId)
  if (recorded === undefined || queuePauseHoldsBack(db, input)) {
    return 0
  }
  return Number(
    db.prepare('DELETE FROM queued_message_pauses WHERE session_id = ?').run(input.sessionId)
      .changes ?? 0
  )
}
