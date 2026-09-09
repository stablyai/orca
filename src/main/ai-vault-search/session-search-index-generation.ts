import type SyncDatabase from '../sqlite/sync-database'

const GENERATION_KEY = 'index_generation'

/**
 * A monotone id for what the index currently publishes.
 *
 * A search page is a slice of one ranked list, so a cursor only means anything
 * against the snapshot that produced it. Every change to what a read can return
 * moves this on, and a cursor minted under an older value is refused rather
 * than silently re-run against a list it no longer indexes into.
 *
 * The value lives in the database, not in a process, because the writer and the
 * reader need not be the same one: PR 3's indexer runs in the scanner child
 * while an engine reads elsewhere, and any number of handles may be open on one
 * file. A generation cached in memory only ever tracks that process's own
 * writes, so a reader would see another writer's deletions while its generation
 * stood still, honour a stale cursor, and skip a session.
 */
export function readIndexGeneration(db: SyncDatabase): number {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(GENERATION_KEY) as
    | { value: string }
    | undefined
  const parsed = row ? Number(row.value) : Number.NaN
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
}

/**
 * Moves the generation on. Must be called INSIDE the transaction that changes
 * what a read returns, for both halves of the reason:
 *
 * - Atomicity. A bump after the commit can be lost to a crash, leaving a
 *   generation that describes content already gone.
 * - Exclusion. Read-then-write from two connections mints the same value twice,
 *   so two different snapshots would answer to one cursor. The increment is a
 *   single statement, and the surrounding `BEGIN IMMEDIATE` is what serialises it.
 */
export function bumpIndexGeneration(db: SyncDatabase): void {
  db.prepare(
    `INSERT INTO meta(key, value) VALUES (?, '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`
  ).run(GENERATION_KEY)
}
