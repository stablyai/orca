import { traceSessionSearch } from '../session-search-trace'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type SyncDatabase from '../../sqlite/sync-database'
import { deleteSearchMessages } from './session-search-message-rows'
import { readIndexGeneration, recordIndexMaintenance } from './session-search-index-generation'

export const RETENTION_DELETE_ROWS_PER_STEP = 256
// Reclaim freed pages incrementally to avoid a long vacuum after the purge.
const RECLAIM_PAGES_PER_STEP = 2000
// FTS merges free pages constantly and later writes reuse them; moving them each drain only churns the file.
const RECLAIM_FREE_PAGE_SHARE = 0.25

/** Hide expired sessions atomically, then reclaim their unreachable messages in bounded transactions. */
export async function deleteExpiredSearchFiles(
  db: SyncDatabase,
  cutoffMs: number | null,
  closed: () => boolean,
  yieldStep: () => Promise<void> = yieldToEventLoop,
  onMessagesChanged: (delta: number) => void = () => undefined,
  reclaim = true
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
        // Recheck expiry under the write lock in case a read refreshed this file after the initial scan.
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
  if (reclaim) {
    await drainOrphanedMessages(db, closed, yieldStep, onMessagesChanged)
  }
}

/** Drain orphaned rows left by retention, replacement, or interruption; the rows record unfinished work. */
export async function drainOrphanedMessages(
  db: SyncDatabase,
  closed: () => boolean,
  yieldStep: () => Promise<void> = yieldToEventLoop,
  onMessagesChanged: (delta: number) => void = () => undefined
): Promise<void> {
  // Finish one session before scanning for the next orphan to avoid repeating that scan per batch.
  const nextOrphan = db.prepare(
    `SELECT session_row_id FROM messages
     WHERE session_row_id NOT IN (SELECT id FROM sessions) LIMIT 1`
  )
  let orphan = (nextOrphan.get() as { session_row_id: number } | undefined)?.session_row_id
  while (orphan !== undefined && !closed()) {
    db.exec('BEGIN IMMEDIATE')
    let deleted = 0
    try {
      const before = readIndexGeneration(db)
      deleted = traceSessionSearch('drain', () =>
        deleteSearchMessages(db, orphan!, RETENTION_DELETE_ROWS_PER_STEP)
      )
      recordIndexMaintenance(db, before)
      db.exec('COMMIT')
      onMessagesChanged(-deleted)
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    reclaimFreePages(db)
    if (deleted < RETENTION_DELETE_ROWS_PER_STEP) {
      orphan = (nextOrphan.get() as { session_row_id: number } | undefined)?.session_row_id
    }
    await yieldStep()
  }
  // removeFile may free pages even when this drain has no orphaned messages.
  reclaimFreePages(db)
}

function reclaimFreePages(db: SyncDatabase): void {
  const free = Number(db.pragma('freelist_count', { simple: true }))
  if (free > Number(db.pragma('page_count', { simple: true })) * RECLAIM_FREE_PAGE_SHARE) {
    traceSessionSearch('vacuum', () => db.pragma(`incremental_vacuum(${RECLAIM_PAGES_PER_STEP})`))
  }
}
