import type Database from '../../sqlite/sync-database'

/** Reuse a caller's transaction without committing or rolling it back. */
export function withProfileStateReadSnapshot<T>(db: Database.Database, read: () => T): T {
  const ownsTransaction = !db.isTransaction
  if (ownsTransaction) {
    db.exec('BEGIN')
  }
  try {
    const result = read()
    if (ownsTransaction) {
      db.exec('COMMIT')
    }
    return result
  } catch (error) {
    if (ownsTransaction) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Preserve the original read error if rollback itself is unavailable.
      }
    }
    throw error
  }
}
