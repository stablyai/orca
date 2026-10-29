import { hardenSqliteDatabaseFiles } from '../../../sqlite/harden-database-files'

export function hardenOrchestrationDatabaseFiles(dbPath: (string & {}) | ':memory:'): void {
  hardenSqliteDatabaseFiles(dbPath)
}
