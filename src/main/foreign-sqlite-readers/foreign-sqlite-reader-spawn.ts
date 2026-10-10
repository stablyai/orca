import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { currentWorkerEntryLayout } from '../worker-thread-entry-path'
import type { CursorDesktopProfileReadResult } from './cursor-profile-result'
import { ForeignSqliteReaderClient } from './foreign-sqlite-reader-client'
import { resolveForeignSqliteReaderEntryPath } from './foreign-sqlite-reader-entry-path'
import type { BinderSessionRow, OpenCodeSessionCursor } from './opencode-binder-sessions-result'

// Why: owns the process-wide client and the real worker factory, so the client
// class stays testable with a fake factory and callers see only plain functions.

function defaultWorkerFactory(): Worker {
  const workerPath = resolveForeignSqliteReaderEntryPath(currentWorkerEntryLayout(__dirname))
  // A missing entry (e.g. a host whose build omits it) throws here so reads fail closed.
  if (!existsSync(workerPath)) {
    throw new Error(`Foreign SQLite reader entry not found: ${workerPath}`)
  }
  return new Worker(workerPath)
}

let sharedClient: ForeignSqliteReaderClient | null = null

function getSharedClient(): ForeignSqliteReaderClient {
  sharedClient ??= new ForeignSqliteReaderClient({ workerFactory: defaultWorkerFactory })
  return sharedClient
}

/**
 * Read the Cursor IDE's stored session on the foreign SQLite reader worker.
 * @param dbPath - Cursor's state.vscdb.
 * @returns `missing`, `ok`, or `error` (also when the worker cannot answer).
 */
export function readCursorDesktopProfile(dbPath: string): Promise<CursorDesktopProfileReadResult> {
  return getSharedClient().readCursorProfile(dbPath)
}

/**
 * List OpenCode 1 sessions newer than `cursor` on the foreign SQLite reader worker.
 * @param dbPath - The shared server's opencode.db.
 * @param cursor - Store position the binder has handled up to.
 * @returns Rows oldest first; `[]` when the store or the worker cannot answer.
 */
export async function readOpenCodeBinderSessions(
  dbPath: string,
  cursor: OpenCodeSessionCursor
): Promise<BinderSessionRow[]> {
  try {
    // Missing stores must not keep an otherwise unused reader worker alive on every binder poll.
    await stat(dbPath)
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return []
    }
    // The worker still owns reporting other failures and checking for changes after this probe.
  }
  return getSharedClient().readOpenCodeBinderSessions(dbPath, cursor)
}
