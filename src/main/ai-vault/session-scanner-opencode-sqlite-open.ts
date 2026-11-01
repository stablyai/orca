import { basename } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { isWslUncPath } from '../../shared/wsl-paths'
import {
  aiVaultScanIssueText,
  type AiVaultScanIssueText
} from '../../shared/ai-vault-scan-issue-copy'
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
  const text =
    kind === 'contended' && !overWslShare
      ? aiVaultScanIssueText('openCodeDatabaseBusy', {
          params: { label, name }
        })
      : kind === 'unreadable'
        ? aiVaultScanIssueText('openCodeDatabaseUnreadable', {
            params: { label, name },
            detail: errorMessage(error)
          })
        : unreadableShareText(dbPath, name, label)
  return { agent, kind: 'scope', path: dbPath, ...text }
}

function unreadableShareText(dbPath: string, name: string, label: string): AiVaultScanIssueText {
  // WSL-share locking cannot be repaired by checkpointing; reserve WAL advice for other filesystems.
  return isWslUncPath(dbPath)
    ? aiVaultScanIssueText('openCodeWslDatabaseUnsupported', {
        params: { label }
      })
    : aiVaultScanIssueText('openCodeWriteAheadLogUnreadable', {
        params: { label, name }
      })
}
