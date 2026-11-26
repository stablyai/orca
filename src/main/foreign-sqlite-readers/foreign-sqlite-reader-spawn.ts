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

const lastCursorProfileByPath = new Map<
  string,
  { stamp: string; result: Extract<CursorDesktopProfileReadResult, { status: 'ok' }> }
>()
const lastEmptyOpenCodeBinderStampByPath = new Map<string, string>()
// A write landing in the same coarse mtime tick as the stat (WAL reset rewriting in
// place at the same size, journal-mode page overwrites, FAT's 2s resolution, or
// ino === 0 platforms) can leave an identical stamp, so a stamp is only trusted once
// every file has been quiet for longer than the coarsest timestamp granularity.
const STAMP_SETTLE_MS = 3_000

type StatStamp = { token: string; newestMs: number } | 'missing' | null
type SqliteTripletStamp =
  | { missing: true }
  | { missing: false; token: string | null; settled: boolean }

async function statStamp(path: string): Promise<StatStamp> {
  try {
    const info = await stat(path)
    return {
      token: `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
      newestMs: Math.max(info.mtimeMs, info.ctimeMs)
    }
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

async function readSqliteTripletStamp(dbPath: string): Promise<SqliteTripletStamp> {
  const settledBeforeMs = Date.now() - STAMP_SETTLE_MS
  const dbStamp = await statStamp(dbPath)
  if (dbStamp === 'missing') {
    return { missing: true }
  }
  if (dbStamp === null) {
    return { missing: false, token: null, settled: false }
  }
  const [walStamp, journalStamp] = await Promise.all([
    statStamp(`${dbPath}-wal`),
    statStamp(`${dbPath}-journal`)
  ])
  if (walStamp === null || journalStamp === null) {
    return { missing: false, token: null, settled: false }
  }
  const stamps = [dbStamp, walStamp, journalStamp]
  const tokens = stamps.map((entry) => (entry === 'missing' ? 'missing' : entry.token))
  return {
    missing: false,
    token: tokens.join('|'),
    settled: stamps.every((entry) => entry === 'missing' || entry.newestMs < settledBeforeMs)
  }
}

export async function readCursorDesktopProfile(
  dbPath: string
): Promise<CursorDesktopProfileReadResult> {
  // Skip absent or unchanged Cursor DBs before waking a worker on every rate-limit poll.
  const triplet = await readSqliteTripletStamp(dbPath)
  if (triplet.missing) {
    lastCursorProfileByPath.delete(dbPath)
    return { status: 'missing' }
  }
  if (triplet.token !== null) {
    const cached = lastCursorProfileByPath.get(dbPath)
    if (cached && cached.stamp === triplet.token) {
      return cached.result
    }
  }
  const result = await getSharedClient().readCursorProfile(dbPath)
  if (result.status === 'ok' && triplet.token !== null && triplet.settled) {
    lastCursorProfileByPath.set(dbPath, { stamp: triplet.token, result })
  } else {
    lastCursorProfileByPath.delete(dbPath)
  }
  return result
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
  // Skip absent or unchanged stores before waking a worker on every binder poll.
  const triplet = await readSqliteTripletStamp(dbPath)
  if (triplet.missing) {
    lastEmptyOpenCodeBinderStampByPath.delete(dbPath)
    return []
  }
  const stamp = triplet.token !== null ? `${triplet.token}|${cursor.ms}|${cursor.id}` : null
  if (stamp !== null && lastEmptyOpenCodeBinderStampByPath.get(dbPath) === stamp) {
    return []
  }
  const result = await getSharedClient().readOpenCodeBinderSessionsWithStatus(dbPath, cursor)
  if (result.ok && result.value.length === 0 && stamp !== null && triplet.settled) {
    lastEmptyOpenCodeBinderStampByPath.set(dbPath, stamp)
  } else {
    lastEmptyOpenCodeBinderStampByPath.delete(dbPath)
  }
  return result.value
}
