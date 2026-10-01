import type Database from '../../sqlite/sync-database'

export class ProfileStateReadRollbackError extends Error {
  readonly code = 'profile-state-read-rollback-failed' as const

  constructor(
    cause: unknown,
    readonly rollbackError: unknown
  ) {
    super('Profile state read failed without releasing its transaction', { cause })
    this.name = 'ProfileStateReadRollbackError'
  }
}

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
    if (ownsTransaction && db.isTransaction) {
      try {
        db.exec('ROLLBACK')
      } catch (rollbackError) {
        throw new ProfileStateReadRollbackError(error, rollbackError)
      }
    }
    throw error
  }
}
