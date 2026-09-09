import type SyncDatabase from '../sqlite/sync-database'

/** An engine feature the index on disk cannot serve. */
export type SessionSearchUnavailableFeature = 'typo-repair' | 'query-log'

/**
 * What this index can answer, probed once when an engine opens over it.
 *
 * Why probe at all: schema version 2 added `messages_vocab` and `search_log`,
 * and a mismatched file is normally dropped and rebuilt when it is opened. But
 * an engine can be handed a connection to a version-1 file that another handle
 * is still answering from, and PR 4 is what first makes that reachable. Reading
 * the tables that do exist and saying plainly which feature is missing is a
 * better answer than throwing on the first query that reaches for one.
 *
 * Which process may open, unlink and rebuild the index is PR 3b's decision, not
 * this file's; this only keeps a reader useful while that is unsettled.
 */
export function sessionSearchUnavailableFeatures(
  db: SyncDatabase
): SessionSearchUnavailableFeature[] {
  const unavailable: SessionSearchUnavailableFeature[] = []
  if (!hasTable(db, 'messages_vocab')) {
    unavailable.push('typo-repair')
  }
  if (!hasTable(db, 'search_log')) {
    unavailable.push('query-log')
  }
  return unavailable
}

function hasTable(db: SyncDatabase, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
      .get(name) !== undefined
  )
}
