import SyncDatabase from './sync-database'

// Why: Agent Session History and OpenCode usage open the user's live
// opencode.db. Without a busy timeout, a concurrent writer (terminal OpenCode
// or Windows exclusive lock) fails the open immediately as "database is locked"
// and the vault surfaces a skipped transcript (#14133).
export const READONLY_SQLITE_BUSY_TIMEOUT_MS = 5_000

export function openReadonlySyncDatabase(
  dbPath: string,
  options: { fileMustExist?: boolean; timeoutMs?: number } = {}
): SyncDatabase {
  const db = new SyncDatabase(dbPath, {
    readonly: true,
    fileMustExist: options.fileMustExist ?? true,
    timeout: options.timeoutMs ?? READONLY_SQLITE_BUSY_TIMEOUT_MS
  })
  db.pragma('query_only = ON')
  return db
}
