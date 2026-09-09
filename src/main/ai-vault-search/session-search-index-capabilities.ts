import type SyncDatabase from '../sqlite/sync-database'

/** An engine feature the index on disk cannot serve. */
export type SessionSearchUnavailableFeature = 'typo-repair' | 'query-log'

/**
 * What this index can answer, probed once when an engine opens over it.
 *
 * Schema version 2 added `messages_vocab` and `search_log`. Every store opens
 * through `openSessionSearchDatabase`, which drops and rebuilds a file whose
 * version it does not recognise, so a lone process cannot reach an engine over
 * a version-1 index: the probe would be dead code if that were the whole story.
 *
 * It is not. Two handles can be open on one file, and the one that rebuilds
 * unlinks it while the other keeps answering from the inode; a table can appear
 * or vanish under a live connection. Which process may rebuild is PR 3b's
 * decision. Until it is settled, reading the tables that are there and naming
 * the feature that is missing beats throwing on the first query that reaches
 * for one, and the engine re-probes rather than trusting this answer forever.
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
