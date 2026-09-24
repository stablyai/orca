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
  try {
    const result = write()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch (rollbackError) {
      throw new ProfileStateIndeterminateWriteError(error, rollbackError)
    }
    throw error
  }
}
