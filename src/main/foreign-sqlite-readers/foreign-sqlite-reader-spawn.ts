import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { Worker } from 'node:worker_threads'
import { spawnWorkerThread } from '../worker-threads/worker-thread-spawn'
import { currentWorkerEntryLayout } from '../worker-threads/worker-thread-entry-path'
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
  return spawnWorkerThread(workerPath, { name: 'orca-foreign-sqlite-reader' })
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

const lastEmptyOpenCodeBinderStampByPath = new Map<string, string>()

async function statStamp(path: string): Promise<string | null> {
  try {
    const info = await stat(path)
    return `${info.ino}:${info.size}:${info.mtimeMs}`
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return 'missing'
    }
    return null
  }
}

/** Return oldest-first rows after cursor; unreadable or unavailable readers answer []. */
export async function readOpenCodeBinderSessions(
  dbPath: string,
  cursor: OpenCodeSessionCursor
): Promise<BinderSessionRow[]> {
  // Skip absent or unchanged stores before waking a worker on every binder poll.
  const dbStamp = await statStamp(dbPath)
  if (dbStamp === 'missing') {
    lastEmptyOpenCodeBinderStampByPath.delete(dbPath)
    return []
  }
  let stamp: string | null = null
  if (dbStamp !== null) {
    const [walStamp, journalStamp] = await Promise.all([
      statStamp(`${dbPath}-wal`),
      statStamp(`${dbPath}-journal`)
    ])
    if (walStamp !== null && journalStamp !== null) {
      stamp = `${dbStamp}|${walStamp}|${journalStamp}|${cursor.ms}|${cursor.id}`
      if (lastEmptyOpenCodeBinderStampByPath.get(dbPath) === stamp) {
        return []
      }
    }
  }
  const result = await getSharedClient().readOpenCodeBinderSessionsWithStatus(dbPath, cursor)
  if (result.ok && result.value.length === 0 && stamp !== null) {
    lastEmptyOpenCodeBinderStampByPath.set(dbPath, stamp)
  } else {
    lastEmptyOpenCodeBinderStampByPath.delete(dbPath)
  }
  return result.value
}
