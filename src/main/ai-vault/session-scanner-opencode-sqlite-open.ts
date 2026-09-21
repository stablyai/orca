import { basename } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { isWslUncPath } from '../../shared/wsl-paths'
import SyncDatabase from '../sqlite/sync-database'
import { classifySqliteReadFailure } from '../sqlite/sqlite-read-failure'
import { errorMessage } from './session-scanner-values'

// Why (#15036): the read used to inherit sqlite3's 0 ms busy timeout, so a
// genuinely contended open failed in ~1 ms. WAL readers almost never block on a
// writer, so this is insurance rather than the fix -- it stays a single bounded
// open, with no retry loop on top of sqlite's own busy handler.
const OPENCODE_SQLITE_BUSY_TIMEOUT_MS = 1_500

/**
 * Open one OpenCode database for reading.
 *
 * Read-only, plus `query_only` as a belt-and-suspenders guard so a bug in a
 * SELECT list can never mutate the user's opencode.db.
 * @param dbPath - Absolute path to an opencode.db file.
 * @returns An open handle the caller must close.
 */
/**
 * Busy timeout for one database.
 *
 * Zero over the WSL share because waiting there is provably useless: Windows
 * cannot take SQLite's locks over \\wsl.localhost at all, so the open fails
 * whatever the timeout. Measured on a real host, the wait is not even bounded
 * by the value — timeout 1500 took ~2400 ms and timeout 5000 took ~7250 ms,
 * while 0 failed in ~21 ms. Paying that per database, per scan, buys nothing
 * and enough such databases would spend the list worker's whole 30 s deadline.
 * @param dbPath - Absolute path to an opencode.db file.
 * @returns Milliseconds to let SQLite's busy handler wait.
 */
export function openCodeBusyTimeoutMs(dbPath: string): number {
  return isWslUncPath(dbPath) ? 0 : OPENCODE_SQLITE_BUSY_TIMEOUT_MS
}

function openOpenCodeDatabaseReadonly(dbPath: string): SyncDatabase {
  const db = new SyncDatabase(dbPath, {
    readonly: true,
    fileMustExist: true,
    timeout: openCodeBusyTimeoutMs(dbPath)
  })
  db.pragma('query_only = ON')
  return db
}

/**
 * Run one synchronous read against an OpenCode database.
 * @param args.dbPath - Absolute path to an opencode.db file.
 * @param args.read - Synchronous reader; its result must be fully materialized.
 * @returns The reader's value; rethrows whatever SQLite raised.
 */
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

/**
 * Describe a whole-database read failure as a scan issue.
 *
 * Kinded so the panel renders this copy instead of counting a failed *source*
 * as a skipped *transcript*; `scope` rather than a new member — see
 * `aiVaultScanIssueSchema` in session-list-result-validation.ts.
 * @param dbPath - Absolute path to the opencode.db that could not be read.
 * @param error - The thrown value from the read.
 * @returns A kinded scan issue with actionable copy.
 */
export function openCodeDatabaseScanIssue(dbPath: string, error: unknown): AiVaultScanIssue {
  const name = basename(dbPath)
  // `fileMustExist` already proved the database file is there before SQLite ran,
  // so this needs no fs probe of its own — an extra sync stat on a 9p share is
  // exactly the hang the WSL transcript gate exists to prevent.
  const kind = classifySqliteReadFailure({ error, databaseFileExists: true })
  // Why: measured against a real distro. Windows cannot take SQLite's file locks
  // over \\wsl.localhost at all — an idle, never-WAL, nothing-attached database
  // answers SQLITE_BUSY just the same, and a 5 s busy timeout does not change it,
  // while the identical bytes copied to local disk open fine. So on this share a
  // lock-family error never means "a writer holds it", and no timeout can help.
  const overWslShare = isWslUncPath(dbPath)
  const detail =
    kind === 'contended' && !overWslShare
      ? `OpenCode is writing to ${name} right now, so its history was skipped. It is read again on the next refresh.`
      : kind === 'unreadable'
        ? `OpenCode history in ${name} could not be read: ${errorMessage(error)}`
        : `OpenCode history in ${name} could not be read. ${unreadableShareAdvice(dbPath)}`
  return { agent: 'opencode', kind: 'scope', path: dbPath, message: detail }
}

function unreadableShareAdvice(dbPath: string): string {
  // Named only when the evidence supports it; a generic share gets generic copy.
  // Deliberately not "flush the write-ahead log": checkpointing changes nothing
  // here, and telling the user to try it would send them after a fix that cannot
  // work. The share itself is the blocker.
  return isWslUncPath(dbPath)
    ? 'Windows cannot open SQLite databases over the \\\\wsl.localhost share, so this history has to be read from inside the distro.'
    : 'Its write-ahead log cannot be opened read-only on this filesystem. Exit OpenCode cleanly to flush the log.'
}
