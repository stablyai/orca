import type SyncDatabase from '../sqlite/sync-database'
import {
  SESSION_SEARCH_GENERATION_SQL,
  SESSION_SEARCH_GENERATION_TRIGGERS
} from './session-search-index-generation'

const QUERY_SCHEMA_SQL = `
-- The typo repair's whole dictionary. Why the index's own vocabulary and not a
-- word list: it can never suggest a term this index does not hold, and it needs
-- no model. fts5vocab is a view over the FTS5 b-tree, so it costs no extra rows.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_vocab USING fts5vocab(messages_fts, 'row');
${SESSION_SEARCH_GENERATION_SQL}`

/** Everything the SQL above creates, so a missing one is what triggers a re-run. */
const OWNED = ['messages_vocab', ...SESSION_SEARCH_GENERATION_TRIGGERS]

/**
 * The vocabulary's target. Creating a fts5vocab table over a missing FTS table
 * succeeds and every query against it then fails, so the feature's health is
 * this name's presence rather than the vocabulary's own.
 */
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
