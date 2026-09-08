import type SyncDatabase from '../sqlite/sync-database'

export const SEARCH_WAL_PENDING_BYTES = 64 * 1024 * 1024
export class SearchWalBackpressureError extends Error {
  constructor() {
    super('Session search indexing is waiting for an older index reader to finish.')
    this.name = 'SearchWalBackpressureError'
  }
}

/** PASSIVE never waits for readers; a blocked checkpoint must not grow without a bound. */
export function assertSearchWalBudget(
  db: SyncDatabase,
  limitBytes = SEARCH_WAL_PENDING_BYTES
): void {
  const row = (db.pragma('wal_checkpoint(PASSIVE)') as { log: number; checkpointed: number }[])[0]
  if (!row || row.log < 0) {
    return
  }
  const pageSize = Number(db.pragma('page_size', { simple: true }))
  if ((row.log - row.checkpointed) * pageSize >= limitBytes) {
    throw new SearchWalBackpressureError()
  }
}
