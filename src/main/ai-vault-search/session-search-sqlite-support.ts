import { isSqliteAvailable } from '../sqlite/sync-database'

/** Older remote hosts may lack SQLite or backup(); leave search unregistered on those runtimes. */
export function sessionSearchSqliteAvailable(): boolean {
  return isSqliteAvailable()
}
