import type Database from '../../sqlite/sync-database'

export class ProfileStateIndeterminateWriteError extends Error {
  readonly code = 'profile-state-write-indeterminate' as const

  constructor(
    cause: unknown,
    readonly rollbackError: unknown
  ) {
    super('Profile state write failed without a confirmed rollback', { cause })
    this.name = 'ProfileStateIndeterminateWriteError'
  }
}

/** Own the write transaction; joining a caller's transaction would weaken its revision fence. */
export function withProfileStateWriteTransaction<T>(db: Database.Database, write: () => T): T {
  if (db.isTransaction) {
    throw new Error('Profile state write requires an idle database connection')
  }
  db.exec('BEGIN IMMEDIATE')
  let committing = false
  try {
    const result = write()
    committing = true
    db.exec('COMMIT')
    return result
  } catch (error) {
    if (!db.isTransaction) {
      // SQLite can roll back a failed statement itself; a failed COMMIT is ambiguous.
      if (committing) {
        throw new ProfileStateIndeterminateWriteError(error, undefined)
      }
      throw error
    }
    try {
      db.exec('ROLLBACK')
    } catch (rollbackError) {
      throw new ProfileStateIndeterminateWriteError(error, rollbackError)
    }
    throw error
  }
}
