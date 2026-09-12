import type SyncDatabase from '../sqlite/sync-database'

const GENERATION_KEY = 'index_generation'

export const SESSION_SEARCH_GENERATION_TRIGGERS = [
  'search_generation_file_insert',
  'search_generation_file_update',
  'search_generation_file_delete',
  'search_generation_orphan_reclaim'
] as const

const BUMP = `INSERT INTO meta(key, value) VALUES ('${GENERATION_KEY}', '1')
    ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;`

/**
 * Triggers commit the generation with writes from any connection.
 * Orphan reclamation also changes the vocabulary used for typo suggestions.
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
CREATE TRIGGER IF NOT EXISTS search_generation_orphan_reclaim AFTER DELETE ON messages
WHEN NOT EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_row_id) BEGIN
  ${BUMP}
END;
`

/** Read the committed generation on each check, including other processes' writes. */
export function readIndexGeneration(db: SyncDatabase): number {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(GENERATION_KEY) as
    | { value: string }
    | undefined
  const parsed = row ? Number(row.value) : Number.NaN
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
}
