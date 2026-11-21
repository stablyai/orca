import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type SyncDatabase from '../../sqlite/sync-database'
import { traceSessionSearch } from '../session-search-trace'

const DELETED_KEY = 'fts_deleted_rows'
const ROWS_KEY = 'fts_rows_at_compaction'
export const SESSION_SEARCH_DELETED_ROWS_TRIGGER = 'search_fts_deleted_rows'

/**
 * FTS5 keeps a deleted row's postings until a merge reaches the segment holding them, and
 * replacing whole sessions deletes rows faster than automerge reaches the oldest segments.
 * An index created before this counter seeds it from its rowid high-water mark, so a store
 * that has replaced many rows compacts once; an empty one starts at zero.
 */
export const SESSION_SEARCH_DELETED_ROWS_SQL = `
INSERT OR IGNORE INTO meta(key, value) SELECT '${DELETED_KEY}', COALESCE(MAX(id), 0) FROM messages;
CREATE TRIGGER IF NOT EXISTS ${SESSION_SEARCH_DELETED_ROWS_TRIGGER} AFTER DELETE ON messages BEGIN
  INSERT INTO meta(key, value) VALUES ('${DELETED_KEY}', '1')
    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
`

// Below this many deletes a stale posting share stays small next to the cost of a rewrite.
const MIN_DELETED_ROWS = 50_000
const MERGE_PAGES_PER_STEP = 64
const RECLAIM_PAGES_PER_STEP = 2000
// About 20 ms of page moves, so a long reclaim after a first compaction rests like the merge.
const PACED_RECLAIM_PAGES_PER_STEP = 512

function metaInteger(db: SyncDatabase, key: string): number {
  const value = Number(db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value)
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

/** Due once deletes since the last compaction reach half the rows it left. */
export function sessionSearchIndexCompactionDue(db: SyncDatabase): boolean {
  const deleted = metaInteger(db, DELETED_KEY)
  return deleted >= Math.max(MIN_DELETED_ROWS, metaInteger(db, ROWS_KEY) / 2)
}

/** Merges every segment in bounded steps, then returns the freed pages. */
export async function compactSessionSearchIndex(
  db: SyncDatabase,
  closed: () => boolean,
  /** Called after every step with its duration, so the caller paces the pass. */
  rest: (workMs: number) => Promise<void>
): Promise<void> {
  const deletedAtStart = metaInteger(db, DELETED_KEY)
  const changes = db.prepare('SELECT total_changes() AS n')
  // Negative merges every level, not only one holding enough segments for automerge.
  const merge = db.prepare("INSERT INTO messages_fts(messages_fts, rank) VALUES('merge', ?)")
  while (!closed()) {
    const before = Number(changes.get()!.n)
    const started = performance.now()
    traceSessionSearch('merge', () => merge.run(-MERGE_PAGES_PER_STEP))
    const merged = Number(changes.get()!.n) - before >= 2
    await rest(performance.now() - started)
    if (!merged) {
      break
    }
  }
  if (closed()) {
    return
  }
  // Deletes during the merge may sit in segments it already wrote; they count toward the next.
  db.prepare('UPDATE meta SET value = MAX(0, CAST(value AS INTEGER) - ?) WHERE key = ?').run(
    deletedAtStart,
    DELETED_KEY
  )
  db.prepare(`INSERT INTO meta(key, value) SELECT ?, COUNT(*) FROM messages WHERE true
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(ROWS_KEY)
  await reclaimSessionSearchFreePages(db, closed, PACED_RECLAIM_PAGES_PER_STEP, rest)
}

export async function reclaimSessionSearchFreePages(
  db: SyncDatabase,
  closed: () => boolean,
  pages = RECLAIM_PAGES_PER_STEP,
  rest: (workMs: number) => Promise<void> = () => yieldToEventLoop()
): Promise<void> {
  let free = closed() ? 0 : Number(db.pragma('freelist_count', { simple: true }))
  while (free > 0 && !closed()) {
    const started = performance.now()
    traceSessionSearch('vacuum', () => db.pragma(`incremental_vacuum(${pages})`))
    const remaining = Number(db.pragma('freelist_count', { simple: true }))
    await rest(performance.now() - started)
    if (remaining >= free) {
      break
    }
    free = remaining
  }
}
