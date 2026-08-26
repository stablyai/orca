import SyncDatabase from './sync-database'

// Why: OpenCode uses WAL, but brief exclusive transitions can still race a reader on Windows.
export const READONLY_SQLITE_BUSY_TIMEOUT_MS = 5_000

const SQLITE_BUSY_PATTERN =
  /database is locked|database is busy|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i

export function isSqliteBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return SQLITE_BUSY_PATTERN.test(message)
}

export function openReadonlySyncDatabase(
  dbPath: string,
  options: { fileMustExist?: boolean; timeoutMs?: number } = {}
): SyncDatabase {
  const db = new SyncDatabase(dbPath, {
    readonly: true,
    fileMustExist: options.fileMustExist ?? true,
    timeout: options.timeoutMs ?? READONLY_SQLITE_BUSY_TIMEOUT_MS
  })
  try {
    db.pragma('query_only = ON')
    // Open can succeed before the first read takes a shared lock.
    db.prepare('SELECT 1 AS ok FROM sqlite_master LIMIT 1').get()
    return db
  } catch (error) {
    try {
      db.close()
    } catch {
      // Preserve the initialization failure.
    }
    throw error
  }
}
