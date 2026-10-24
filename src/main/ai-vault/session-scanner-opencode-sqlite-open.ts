import { basename } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { isWslUncPath } from '../../shared/wsl-paths'
import SyncDatabase from '../sqlite/sync-database'
import { classifySqliteReadFailure } from '../sqlite/sqlite-read-failure'
import { errorMessage } from './session-scanner-values'

// Allow bounded contention waits for native reads without adding retries atop SQLite’s busy handler (#15036).
const OPENCODE_SQLITE_BUSY_TIMEOUT_MS = 1_500

/** WSL-share locks fail even when idle; waiting wastes the worker deadline and can exceed the requested timeout. */
export function openCodeBusyTimeoutMs(dbPath: string): number {
  return isWslUncPath(dbPath) ? 0 : OPENCODE_SQLITE_BUSY_TIMEOUT_MS
}

export function openOpenCodeDatabaseReadonly(dbPath: string): SyncDatabase {
  const db = new SyncDatabase(dbPath, {
    readonly: true,
    fileMustExist: true,
    timeout: openCodeBusyTimeoutMs(dbPath)
  })
  try {
    db.pragma('query_only = ON')
    return db
  } catch (error) {
    try {
      db.close()
    } catch {
      // Preserve the query_only setup failure if closing also fails.
    }
    throw error
  }
}

/** Materialize the read synchronously; the database closes before this function returns. */
export function readOpenCodeDatabase<T>(args: {
  dbPath: string
  read: (db: SyncDatabase) => T
}): T {
  const db = openOpenCodeDatabaseReadonly(args.dbPath)
  try {
    return args.read(db)
  } finally {
    db.close()
  }
}

/** Report a failed database as one scope issue instead of counting it as a skipped transcript. */
export function openCodeDatabaseScanIssue(
  dbPath: string,
  error: unknown,
  agent: 'opencode' | 'zcode' = 'opencode'
): AiVaultScanIssue {
  const name = basename(dbPath)
  const label = agent === 'zcode' ? 'ZCode' : 'OpenCode'
  // Avoid an extra synchronous existence probe that could hang on a WSL share.
  const kind = classifySqliteReadFailure({ error, databaseFileExists: true })
  // WSL-share lock errors do not establish writer contention; idle databases exhibit the same failure.
  const overWslShare = isWslUncPath(dbPath)
  const detail =
    kind === 'contended' && !overWslShare
      ? `${label} is writing to ${name} right now, so its history was skipped. It is read again on the next refresh.`
      : kind === 'unreadable'
        ? `${label} history in ${name} could not be read: ${errorMessage(error)}`
        : unreadableShareDetail(dbPath, name, label)
  return { agent, kind: 'scope', path: dbPath, message: detail }
}

function unreadableShareDetail(dbPath: string, name: string, label: string): string {
  // WSL-share locking cannot be repaired by checkpointing; reserve WAL advice for other filesystems.
  return isWslUncPath(dbPath)
    ? `${label} sessions inside WSL can't be searched from Windows yet.`
    : `${label} history in ${name} could not be read. Its write-ahead log cannot be opened read-only on this filesystem. Exit ${label} cleanly to flush the log.`
}
