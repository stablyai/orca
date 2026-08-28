// Why (#15036): a read-only SQLite open can fail for reasons that demand
// opposite responses, and both arrive as an opaque driver string. Contention is
// transient — retry later, never persist it as a permanent failure. A missing
// wal-index is structural — retrying forever cannot fix it.

/** Primary result codes; extended codes pack the primary code in the low byte. */
const SQLITE_BUSY = 5
const SQLITE_LOCKED = 6
const SQLITE_CANTOPEN = 14

// Shared with the Codex index-heal pass, which only ever sees a relayed message
// string (app-server RPC drops `errcode`), so message matching is not optional.
const CONTENTION_MESSAGE = /SQLITE_(?:BUSY|LOCKED)|database (?:is )?(?:busy|locked)/i

function primaryErrcode(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('errcode' in error)) {
    return null
  }
  const errcode = (error as { errcode?: unknown }).errcode
  return typeof errcode === 'number' && Number.isFinite(errcode) ? errcode & 0xff : null
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * True when a SQLite failure means "someone else holds the database right now".
 * @param error - The thrown value from a `node:sqlite` call or a relayed message.
 * @returns Whether the caller should retry later rather than record a failure.
 */
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
  /**
   * The database file itself is present, but SQLite still could not open the
   * set of files it needs — in practice the `-wal`/`-shm` pair a read-only WAL
   * open requires, which shares that cannot host SQLite shared memory (9p
   * `\\wsl.localhost`, SMB, SSHFS) refuse. Retrying cannot fix it.
   */
  | 'wal-index-unavailable'
  /** Anything else: corrupt file, wrong schema, permissions. */
  | 'unreadable'

/**
 * Classify why a read-only SQLite open or query failed.
 *
 * Pure: the caller supplies the "does the database file exist" evidence, so
 * neither branch needs a filesystem probe of its own. That matters on a WSL 9p
 * share, where an extra sync stat is exactly the hang the transcript gate exists
 * to prevent.
 * @param args.error - The thrown value.
 * @param args.databaseFileExists - Whether the main database file was present.
 * @returns Which of the three failure modes the error represents.
 */
export function classifySqliteReadFailure(args: {
  error: unknown
  databaseFileExists: boolean
}): SqliteReadFailureKind {
  if (isTransientSqliteContention(args.error)) {
    return 'contended'
  }
  // SQLITE_CANTOPEN against a database that is right there names a companion
  // file — the wal-index a read-only WAL open needs — not the database itself.
  if (primaryErrcode(args.error) === SQLITE_CANTOPEN && args.databaseFileExists) {
    return 'wal-index-unavailable'
  }
  return 'unreadable'
}
