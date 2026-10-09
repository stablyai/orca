import { isSqliteAvailable } from '../sqlite/sync-database'

/**
 * Whether this Node can hold an index at all.
 */
export function sessionSearchSqliteAvailable(): boolean {
  return isSqliteAvailable()
}
