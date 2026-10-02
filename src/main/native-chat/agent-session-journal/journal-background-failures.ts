// The background copy's give-ups: a step on one chat that failed in a way no retry reads past, so
// the job (structured-agent-session-per-chat-file-copy.ts) skips it while nothing it read changed.
// Each is keyed to the step's input as the failing try left it, plus the app version:
// - `copy`: a per-chat file that will not open, or whose copy did not read back as the file; keyed
//   to the size and mtime of `journal.db` and of its `-wal`.
// - `status`: a chat in the host's database whose missing status row could not be written, or whose
//   history is corrupt (it gets no row, so its open rebuilds it); keyed to its epoch and tip.
// Any change (a write, a checkpoint, an update) makes the chat owed again, for one more try. A
// user's own open of the chat still tries the copy, and writes its own status row.
//
// Created at every writable open with no `user_version` bump, as the stored chat state is: an older
// build ignores it and stays writable.

import { isTransientSqliteContention } from '../../sqlite/sqlite-read-failure'
import type Database from '../../sqlite/sync-database'
import { JournalImportAbortedError } from './journal-open-failure'
import { statPerChatFile, type PerChatFileState } from './journal-per-session-source'

export type JournalBackgroundStep = 'copy' | 'status'

/** How a step failed: stopped for quit, likely to clear on a later try, or not. */
export type JournalBackgroundFailureKind = 'aborted' | 'transient' | 'deterministic'

const SQLITE_IOERR = 10
const SQLITE_FULL = 13
const TRANSIENT_FS_CODES = new Set(['ENOSPC', 'EBUSY', 'EMFILE', 'ENFILE', 'EIO', 'EAGAIN'])
const MAX_CAUSE_DEPTH = 8

export function classifyJournalBackgroundFailure(error: unknown): JournalBackgroundFailureKind {
  let current = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (current instanceof JournalImportAbortedError) {
      return 'aborted'
    }
    if (isTransientSqliteContention(current) || isTransientIoFailure(current)) {
      return 'transient'
    }
    current = current.cause
  }
  return 'deterministic'
}

function isTransientIoFailure(error: Error): boolean {
  const errcode = 'errcode' in error ? error.errcode : undefined
  if (typeof errcode === 'number') {
    const primary = errcode & 0xff
    return primary === SQLITE_IOERR || primary === SQLITE_FULL
  }
  return 'code' in error && typeof error.code === 'string' && TRANSIENT_FS_CODES.has(error.code)
}

export function ensureJournalBackgroundFailuresTable(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS journal_background_failures (
  session_id  TEXT    NOT NULL,
  step        TEXT    NOT NULL,
  input       TEXT    NOT NULL,
  app_version TEXT    NOT NULL,
  reason      TEXT    NOT NULL,
  failed_at   INTEGER NOT NULL,
  PRIMARY KEY (session_id, step)
);
`)
}

/** The `copy` step's input: the file and its WAL as they stand. */
function perChatFileInput(file: PerChatFileState): string {
  return `${file.dbSize}:${file.dbMtimeMs}:${file.walSize ?? '-'}:${file.walMtimeMs ?? '-'}`
}

type FailureKey = { sessionId: string; step: JournalBackgroundStep }

const UPSERT_FAILURE = `INSERT INTO journal_background_failures (session_id, step, input,
  app_version, reason, failed_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id, step) DO UPDATE SET
  input = excluded.input, app_version = excluded.app_version, reason = excluded.reason,
  failed_at = excluded.failed_at`
const SELECT_FAILURE = `SELECT input, app_version FROM journal_background_failures
WHERE session_id = ? AND step = ?`
const DELETE_FAILURE = 'DELETE FROM journal_background_failures WHERE session_id = ? AND step = ?'

/** Keyed to the step's input as the failing try left it; nothing is recorded when there is none
 *  left to key (null). Bookkeeping: a failure to record is logged, and only costs one more try. */
export function recordJournalBackgroundFailure(
  db: Database.Database,
  input: FailureKey & {
    readInput: () => string | null
    appVersion: string
    error: unknown
    failedAt: number
  }
): void {
  try {
    const key = input.readInput()
    if (key === null) {
      return
    }
    db.prepare(UPSERT_FAILURE).run(
      input.sessionId,
      input.step,
      key,
      input.appVersion,
      input.error instanceof Error ? input.error.message : String(input.error),
      input.failedAt
    )
  } catch (error) {
    console.warn('[agent-session-journal] recording a failed background step failed', error)
  }
}

/** Whether the step's last recorded failure was on this very input, under this app version. */
export function journalBackgroundFailureStands(
  db: Database.Database,
  key: FailureKey & { input: string; appVersion: string }
): boolean {
  const row = db.prepare(SELECT_FAILURE).get(key.sessionId, key.step)
  return row?.input === key.input && row.app_version === key.appVersion
}

/** The `copy` step's give-up, keyed to the chat's per-chat file as it stands now. */
export function recordPerChatFileCopyFailure(
  db: Database.Database,
  input: { sessionId: string; legacyDirectory: string } & Omit<
    Parameters<typeof recordJournalBackgroundFailure>[1],
    'sessionId' | 'step' | 'readInput'
  >
): void {
  recordJournalBackgroundFailure(db, {
    ...input,
    step: 'copy',
    readInput: () => {
      const file = statPerChatFile(input.legacyDirectory)
      return file && perChatFileInput(file)
    }
  })
}

export function perChatFileCopyFailureStands(
  db: Database.Database,
  key: { sessionId: string; file: PerChatFileState; appVersion: string }
): boolean {
  return journalBackgroundFailureStands(db, {
    sessionId: key.sessionId,
    step: 'copy',
    input: perChatFileInput(key.file),
    appVersion: key.appVersion
  })
}

export function deleteJournalBackgroundFailure(db: Database.Database, key: FailureKey): void {
  db.prepare(DELETE_FAILURE).run(key.sessionId, key.step)
}

/** What it was keyed to is gone, so its give-up is too. Reads first: most chats never had one. */
export function forgetJournalBackgroundFailure(db: Database.Database, key: FailureKey): void {
  if (db.prepare(SELECT_FAILURE).get(key.sessionId, key.step)) {
    deleteJournalBackgroundFailure(db, key)
  }
}
