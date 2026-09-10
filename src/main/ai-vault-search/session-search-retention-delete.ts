import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type SyncDatabase from '../sqlite/sync-database'
import { deleteSearchMessages } from './session-search-message-rows'

export const RETENTION_DELETE_ROWS_PER_STEP = 256
// Why in step with the deletes rather than one sweep at the end: `auto_vacuum =
// INCREMENTAL` holds every freed page until something asks for it back, and
// asking for a whole purge's worth at once is one long stall (40 ms per 22 MB
// freed, measured) instead of many short ones.
const RECLAIM_PAGES_PER_STEP = 2000

/**
 * Drops every file older than the cutoff, then hands its rows back in bounded
 * steps.
 *
 * The two halves are separate on purpose. Cutting a session loose from its file
 * is one small transaction, and it is what makes the session stop answering
 * searches — every read joins `sessions`, so a row whose session is gone is
 * already unreachable. Reclaiming those rows is the expensive half, and it can
 * be paused, interrupted or resumed at any point without a reader ever seeing a
 * session that is half deleted. A crash in the middle leaves rows nothing
 * points at, and `drainOrphanedMessages` finds them on the next pass.
 */
export async function deleteExpiredSearchFiles(
  db: SyncDatabase,
  cutoffMs: number | null,
  closed: () => boolean,
  yieldStep: () => Promise<void> = yieldToEventLoop
): Promise<void> {
  if (cutoffMs !== null) {
    const expired = db
      .prepare('SELECT path FROM files WHERE mtime_ms < ? ORDER BY mtime_ms')
      .all(cutoffMs) as { path: string }[]
    for (const { path } of expired) {
      if (closed()) {
        return
      }
      db.exec('BEGIN IMMEDIATE')
      try {
        // Re-read under the lock: a read of this file may have landed since the
        // list was taken, which makes it new enough to keep.
        const file = db
          .prepare('SELECT session_row_id FROM files WHERE path = ? AND mtime_ms < ?')
          .get(path, cutoffMs) as { session_row_id: number | null } | undefined
        if (file) {
          db.prepare('DELETE FROM sessions WHERE id = ?').run(file.session_row_id)
          db.prepare('DELETE FROM files WHERE path = ?').run(path)
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      await yieldStep()
    }
  }
  await drainOrphanedMessages(db, closed, yieldStep)
}

/**
 * Deletes rows whose session no longer exists, a bounded batch per transaction.
 *
 * That set is exactly what retention, a removed source and an interrupted
 * earlier drain leave behind, so the index needs no record of unfinished work
 * beyond the rows themselves.
 */
async function drainOrphanedMessages(
  db: SyncDatabase,
  closed: () => boolean,
  yieldStep: () => Promise<void> = yieldToEventLoop
): Promise<void> {
  // Ordered by session so one call to this walks a session's rows to the end
  // before paying for the scan that finds the next one.
  const nextOrphan = db.prepare(
    `SELECT session_row_id FROM messages
     WHERE session_row_id NOT IN (SELECT id FROM sessions) LIMIT 1`
  )
  let orphan = (nextOrphan.get() as { session_row_id: number } | undefined)?.session_row_id
  while (orphan !== undefined && !closed()) {
    db.exec('BEGIN IMMEDIATE')
    let deleted = 0
    try {
      deleted = deleteSearchMessages(db, orphan, RETENTION_DELETE_ROWS_PER_STEP)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    db.pragma(`incremental_vacuum(${RECLAIM_PAGES_PER_STEP})`)
    if (deleted < RETENTION_DELETE_ROWS_PER_STEP) {
      orphan = (nextOrphan.get() as { session_row_id: number } | undefined)?.session_row_id
    }
    await yieldStep()
  }
  // A `removeFile` frees its pages outside this loop and may leave none to drain.
  db.pragma(`incremental_vacuum(${RECLAIM_PAGES_PER_STEP})`)
}
