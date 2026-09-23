import type Database from '../../sqlite/sync-database'

/** Own the write transaction; joining a caller's transaction would weaken its revision fence. */
export function withProfileStateWriteTransaction<T>(db: Database.Database, write: () => T): T {
  if (db.isTransaction) {
    throw new Error('Profile state write requires an idle database connection')
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = write()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Preserve the write failure if rollback is unavailable.
    }
    throw error
  }
}
