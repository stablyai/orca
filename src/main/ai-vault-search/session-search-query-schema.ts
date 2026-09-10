import type SyncDatabase from '../sqlite/sync-database'
import {
  SESSION_SEARCH_GENERATION_SQL,
  SESSION_SEARCH_GENERATION_TRIGGERS
} from './session-search-index-generation'

/** An engine feature the index on disk cannot serve. */
export type SessionSearchUnavailableFeature = 'typo-repair'

const QUERY_SCHEMA_SQL = `
-- The typo repair's whole dictionary. Why the index's own vocabulary and not a
-- word list: it can never suggest a term this index does not hold, and it needs
-- no model. fts5vocab is a view over the FTS5 b-tree, so it costs no extra rows.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_vocab USING fts5vocab(messages_fts, 'row');
-- Locally logged queries, stored as typed, bounded. Nothing writes here unless a
-- caller opts in; the eval set is rebuilt from it (see session-search-query-log).
CREATE TABLE IF NOT EXISTS search_log(
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  query TEXT NOT NULL,
  route TEXT NOT NULL,
  hits INTEGER NOT NULL,
  duration_ms REAL NOT NULL
);
${SESSION_SEARCH_GENERATION_SQL}`

/** Everything the SQL above creates, so a missing one is what triggers a re-run. */
const OWNED = ['messages_vocab', 'search_log', ...SESSION_SEARCH_GENERATION_TRIGGERS]

/**
 * The vocabulary's target. Creating a fts5vocab table over a missing FTS table
 * succeeds and every query against it then fails, so the feature's health is
 * this name's presence rather than the vocabulary's own.
 */
const VOCABULARY_SOURCE = 'messages_fts'

const PROBED = [...OWNED, VOCABULARY_SOURCE]

/**
 * Creates whatever of the engine's own schema is missing, and reports what it
 * still cannot serve.
 *
 * These objects are the query engine's, not the store's. Nothing on the write
 * path reads any of them, so under the stack's YAGNI rule they do not belong in
 * PR 2's schema, and an index built by a process that never opens an engine
 * carries none of their cost. None of them needs a schema version either: every
 * one is derived from what PR 2 already holds, so re-creating them over any of
 * its files is correct, while a version bump would throw a whole index away to
 * add a view over its own b-tree.
 *
 * Run per search, not once per engine. A capability is a fact about the file
 * rather than about this object: another handle can rebuild the index under a
 * live connection, so a verdict taken in a constructor is wrong for the rest of
 * the engine's life in both directions — it would keep reaching for a table
 * that went away and never pick one back up when it returned. The steady-state
 * cost is the single indexed `sqlite_master` lookup below.
 *
 * A create that throws is not caught. The only way to reach one is an index
 * whose `files` table is gone, which is a rebuild in flight — and an engine
 * over that cannot report a hit's source either, so there is nothing to degrade
 * to. Losing only the vocabulary's source is the case worth surviving, and that
 * one is reported rather than thrown.
 */
export function ensureSessionSearchQuerySchema(
  db: SyncDatabase
): readonly SessionSearchUnavailableFeature[] {
  const present = presentNames(db)
  if (OWNED.some((name) => !present.has(name))) {
    db.exec(QUERY_SCHEMA_SQL)
  }
  return present.has(VOCABULARY_SOURCE) ? [] : ['typo-repair']
}

function presentNames(db: SyncDatabase): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE name IN (${PROBED.map(() => '?').join(',')})`)
    .all(...PROBED) as { name: string }[]
  return new Set(rows.map((row) => row.name))
}
