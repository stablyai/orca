import type SyncDatabase from '../sqlite/sync-database'

const GENERATION_KEY = 'index_generation'

/**
 * Names of the triggers that move the generation. Exported so the query schema
 * can check they are all still there before an engine trusts a cursor.
 */
export const SESSION_SEARCH_GENERATION_TRIGGERS = [
  'search_generation_file_insert',
  'search_generation_file_update',
  'search_generation_file_delete'
] as const

const BUMP = `INSERT INTO meta(key, value) VALUES ('${GENERATION_KEY}', '1')
    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;`

/**
 * The fence, as three triggers on `files`.
 *
 * Why `files` and not `sessions` or `messages`. Every transaction the store
 * opens that can change what a search returns writes this table, and nothing
 * else does: a committed read upserts the file's cursor beside its rows, a
 * chunk of a long read upserts the partial sentinel beside its prefix,
 * `removeFile` deletes the row with the session, and retention deletes the
 * file row in the same transaction as the session row. The one write path that
 * does not touch `files` is retention's orphan drain, and that is exactly the
 * one that must not bump: those rows are already unreachable — their session
 * row is gone and every retrieval inner-joins `sessions` — so reclaiming them
 * changes no answer, while bumping would refuse every outstanding cursor once
 * per 256 rows.
 *
 * A trigger rather than a call the writer makes, for two reasons. PR 4 does not
 * own the writer, and more importantly the fence has to hold for writers this
 * process cannot see: the triggers live in the file, so PR 3's indexer in the
 * scanner child moves the generation without knowing a reader exists.
 *
 * Correctness comes from where the increment runs, not from what it counts. It
 * is one statement inside the writer's own `BEGIN IMMEDIATE`, so it commits
 * with the change it describes and two connections cannot mint one value twice.
 * It over-counts in one harmless direction: a read that decoded no session from
 * a file the index also held no session for advances a cursor and bumps
 * anyway. That refuses a cursor early; it never honours one late.
 */
export const SESSION_SEARCH_GENERATION_SQL = `
CREATE TRIGGER IF NOT EXISTS search_generation_file_insert AFTER INSERT ON files BEGIN
  ${BUMP}
END;
CREATE TRIGGER IF NOT EXISTS search_generation_file_update AFTER UPDATE ON files BEGIN
  ${BUMP}
END;
CREATE TRIGGER IF NOT EXISTS search_generation_file_delete AFTER DELETE ON files BEGIN
  ${BUMP}
END;
`

/**
 * A monotone id for what the index currently publishes.
 *
 * A search page is a slice of one ranked list, so a cursor only means anything
 * against the snapshot that produced it. Every change to what a read can return
 * moves this on, and a cursor minted under an older value is refused rather
 * than silently re-run against a list it no longer indexes into.
 *
 * Read from the database on every call, never cached in a process. The writer
 * and the reader need not be the same one: PR 3's indexer runs in the scanner
 * child while an engine reads elsewhere, and any number of handles may be open
 * on one file. A generation cached in memory only ever tracks that process's
 * own writes, so a reader would see another writer's deletions while its
 * generation stood still, honour a stale cursor, and skip a session.
 */
export function readIndexGeneration(db: SyncDatabase): number {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(GENERATION_KEY) as
    | { value: string }
    | undefined
  const parsed = row ? Number(row.value) : Number.NaN
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
}
