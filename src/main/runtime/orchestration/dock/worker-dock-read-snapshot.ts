import type Database from '../../../sqlite/sync-database'

/** A consistent count/window read must not acquire a writer reservation. */
export function readWorkerDockSnapshot<T>(db: Database.Database, read: () => T): T {
  if (db.isTransaction) {
    return read()
  }
  db.exec('BEGIN')
  try {
    const result = read()
    db.exec('COMMIT')
    return result
  } catch (error) {
    if (db.isTransaction) {
      db.exec('ROLLBACK')
    }
    throw error
  }
}
