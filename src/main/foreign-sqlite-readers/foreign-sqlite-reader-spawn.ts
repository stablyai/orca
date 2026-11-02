import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { currentWorkerEntryLayout } from '../worker-thread-entry-path'
import type { CursorDesktopProfileReadResult } from './cursor-profile-result'
import { ForeignSqliteReaderClient } from './foreign-sqlite-reader-client'
import { resolveForeignSqliteReaderEntryPath } from './foreign-sqlite-reader-entry-path'
import type { BinderSessionRow, OpenCodeSessionCursor } from './opencode-binder-sessions-result'
import type {
  OpenCodePromptFailureQuery,
  OpenCodePromptFailureResult
} from './opencode-prompt-failure-result'

function defaultWorkerFactory(): Worker {
  const workerPath = resolveForeignSqliteReaderEntryPath(currentWorkerEntryLayout(__dirname))
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

export function readCursorDesktopProfile(dbPath: string): Promise<CursorDesktopProfileReadResult> {
  return getSharedClient().readCursorProfile(dbPath)
}

export function readOpenCodePromptFailure(
  query: OpenCodePromptFailureQuery
): Promise<OpenCodePromptFailureResult> {
  return getSharedClient().readOpenCodePromptFailure(query)
}

/** Return oldest-first rows after cursor; unreadable or unavailable readers answer []. */
export async function readOpenCodeBinderSessions(
  dbPath: string,
  cursor: OpenCodeSessionCursor
): Promise<BinderSessionRow[]> {
  try {
    // Skip absent stores before waking a worker on every binder poll.
    await stat(dbPath)
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return []
    }
    // Other stat failures still go through worker error reporting and its fresh open.
  }
  return getSharedClient().readOpenCodeBinderSessions(dbPath, cursor)
}
