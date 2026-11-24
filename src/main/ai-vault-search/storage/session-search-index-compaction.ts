import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type SyncDatabase from '../../sqlite/sync-database'
import { traceSessionSearch } from '../session-search-trace'

const DELETED_KEY = 'fts_deleted_rows'
const ROWS_KEY = 'fts_rows_at_compaction'
// Set with a pass's first merge and cleared when it completes, so a pass cut short resumes.
const STARTED_KEY = 'fts_compaction_started_at_deleted'

/**
 * FTS5 keeps a deleted row's postings until a merge reaches the segment holding them, and
 * replacing whole sessions deletes rows faster than automerge reaches the oldest segments.
 * An index from before this counter seeds it with the rows it has ever deleted (rowid
 * high-water mark minus live rows), so one that replaced many rows compacts once.
 */
export function seedSessionSearchDeletedRows(db: SyncDatabase): void {
  // COUNT(*) walks every row, so only an index without the counter pays it, once.
  if (db.prepare('SELECT 1 FROM meta WHERE key = ?').get(DELETED_KEY)) {
    return
  }
  db.prepare(`INSERT OR IGNORE INTO meta(key, value)
    SELECT ?, MAX(0, COALESCE(MAX(id), 0) - COUNT(*)) FROM messages WHERE true`).run(DELETED_KEY)
}

/** Counted per delete call in its transaction; a per-row trigger makes FTS5 flush on every row. */
export function recordSessionSearchDeletedRows(db: SyncDatabase, rows: number): void {
  if (rows > 0) {
    db.prepare(`INSERT INTO meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + excluded.value`).run(
      DELETED_KEY,
      String(rows)
    )
  }
}

// Below this many deletes a stale posting share stays small next to the cost of a rewrite.
const MIN_DELETED_ROWS = 50_000
const MERGE_PAGES_PER_STEP = 64
const RECLAIM_PAGES_PER_STEP = 2000
// Small steps, so a long reclaim after a first compaction rests like the merge does.
const PACED_RECLAIM_PAGES_PER_STEP = 512

function metaInteger(db: SyncDatabase, key: string): number {
  const value = Number(db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value)
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

/** Due once deletes since the last compaction reach half the rows it left, or a pass was cut short. */
export function sessionSearchIndexCompactionDue(db: SyncDatabase): boolean {
  if (db.prepare('SELECT 1 FROM meta WHERE key = ?').get(STARTED_KEY)) {
    return true
  }
  const deleted = metaInteger(db, DELETED_KEY)
  return deleted >= Math.max(MIN_DELETED_ROWS, metaInteger(db, ROWS_KEY) / 2)
}

/** Merges every segment in steps of 64 written pages, then returns the freed pages. */
export async function compactSessionSearchIndex(
  db: SyncDatabase,
  closed: () => boolean,
  /** Called after every step with its duration, so the caller paces the pass. */
  rest: (workMs: number) => Promise<void>
): Promise<void> {
  const resumed = db.prepare('SELECT 1 FROM meta WHERE key = ?').get(STARTED_KEY) !== undefined
  const deletedAtStart = metaInteger(db, resumed ? STARTED_KEY : DELETED_KEY)
  const changes = db.prepare('SELECT total_changes() AS n')
  const merge = db.prepare("INSERT INTO messages_fts(messages_fts, rank) VALUES('merge', ?)")
  // Writing the whole file twice bounds the pass even if indexing keeps adding segments.
  const maxSteps =
    (2 * Number(db.pragma('page_count', { simple: true }))) / MERGE_PAGES_PER_STEP + 16
  for (let step = 0; step < maxSteps && !closed(); step++) {
    const before = Number(changes.get()!.n)
    const started = performance.now()
    if (step === 0 && !resumed) {
      // A negative step starts one merge over every segment present now; the marker commits with
      // it. Later steps, including a resumed pass's, only continue that merge, so segments
      // indexing commits meanwhile aren't pulled in and merged work isn't redone.
      db.exec('BEGIN IMMEDIATE')
      try {
        traceSessionSearch('merge', () => merge.run(-MERGE_PAGES_PER_STEP))
        db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
          STARTED_KEY,
          String(deletedAtStart)
        )
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    } else {
      traceSessionSearch('merge', () => merge.run(MERGE_PAGES_PER_STEP))
    }
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
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE meta SET value = MAX(0, CAST(value AS INTEGER) - ?) WHERE key = ?').run(
      deletedAtStart,
      DELETED_KEY
    )
    db.prepare(`INSERT INTO meta(key, value) SELECT ?, COUNT(*) FROM messages WHERE true
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(ROWS_KEY)
    db.prepare('DELETE FROM meta WHERE key = ?').run(STARTED_KEY)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
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
    if (remaining >= free || closed()) {
      break
    }
    // The rest may drain rows, freeing more pages.
    free = Number(db.pragma('freelist_count', { simple: true }))
  }
}
