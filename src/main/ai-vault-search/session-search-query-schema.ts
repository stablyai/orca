import type SyncDatabase from '../sqlite/sync-database'
import {
  SESSION_SEARCH_GENERATION_SQL,
  SESSION_SEARCH_GENERATION_TRIGGERS
} from './session-search-index-generation'

const QUERY_SCHEMA_SQL = `
-- Use indexed vocabulary so typo repair suggests only terms the index holds.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_vocab USING fts5vocab(messages_fts, 'row');
${SESSION_SEARCH_GENERATION_SQL}`

const OWNED = ['messages_vocab', ...SESSION_SEARCH_GENERATION_TRIGGERS]

// fts5vocab creation succeeds without its source table, so check that source explicitly.
const VOCABULARY_SOURCE = 'messages_fts'

const PROBED = [...OWNED, VOCABULARY_SOURCE]

/** Restore derived objects; a missing source index requires the owner to rebuild. */
export function ensureSessionSearchQuerySchema(db: SyncDatabase): void {
  const present = presentNames(db)
  if (!present.has(VOCABULARY_SOURCE)) {
    throw new Error('Session search index unavailable: missing messages_fts')
  }
  if (OWNED.some((name) => !present.has(name))) {
    db.exec(QUERY_SCHEMA_SQL)
  }
}

function presentNames(db: SyncDatabase): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE name IN (${PROBED.map(() => '?').join(',')})`)
    .all(...PROBED) as { name: string }[]
  return new Set(rows.map((row) => row.name))
}
