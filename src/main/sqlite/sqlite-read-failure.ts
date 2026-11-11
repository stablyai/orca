// #15036: retry transient contention, but missing wal-index is structural; opaque driver text must not conflate them.

/** Primary result codes; extended codes pack the primary code in the low byte. */
const SQLITE_BUSY = 5
const SQLITE_LOCKED = 6
const SQLITE_CORRUPT = 11
const SQLITE_CANTOPEN = 14
const SQLITE_NOTADB = 26

// Relayed app-server errors omit errcode, so Codex index-heal also needs message matching.
const CONTENTION_MESSAGE = /SQLITE_(?:BUSY|LOCKED)|database (?:is )?(?:busy|locked)/i

function primaryErrcode(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null
  }
  const errcode = 'errcode' in error ? error.errcode : undefined
  return typeof errcode === 'number' && Number.isFinite(errcode) ? errcode & 0xff : null
}

export function isSqliteDriverError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ERR_SQLITE_ERROR'
}

export function isSqliteCorruption(error: unknown): boolean {
  if (!isSqliteDriverError(error)) {
    return false
  }
  const errcode = primaryErrcode(error)
  return errcode === SQLITE_CORRUPT || errcode === SQLITE_NOTADB
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Transient contention may succeed on retry; never persist it as permanent failure. */
export function isTransientSqliteContention(error: unknown): boolean {
  const errcode = primaryErrcode(error)
  if (errcode === SQLITE_BUSY || errcode === SQLITE_LOCKED) {
    return true
  }
  return CONTENTION_MESSAGE.test(errorText(error))
}

export type SqliteReadFailureKind =
  /** Another connection holds the lock; the same read can succeed later. */
  | 'contended'
  /** Required read-only WAL companion files unavailable, as on 9p/SMB/SSHFS without SQLite shared memory; retries cannot fix it. */
  | 'wal-index-unavailable'
  /** Anything else: corrupt file, wrong schema, permissions. */
  | 'unreadable'

/** Use caller-supplied presence evidence; an extra synchronous stat over WSL 9p could itself hang. */
export function classifySqliteReadFailure(args: {
  error: unknown
  databaseFileExists: boolean
}): SqliteReadFailureKind {
  if (isTransientSqliteContention(args.error)) {
    return 'contended'
  }
  // CANTOPEN with proven database presence means required companion files are unavailable.
  if (primaryErrcode(args.error) === SQLITE_CANTOPEN && args.databaseFileExists) {
    return 'wal-index-unavailable'
  }
  return 'unreadable'
}
