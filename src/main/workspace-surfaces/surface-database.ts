import type Database from '../sqlite/sync-database'

/** The admitted storage owner supplies the connection and the transaction boundary. */
export type WorkspaceSurfaceDatabase = {
  readonly db: Database.Database
  readonly readOnly: boolean
  transaction<T>(run: (db: Database.Database) => T): T
}
