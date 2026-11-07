import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import SyncDatabase from '../../../sqlite/sync-database'

const STATE_DB_FILE_PATTERN = /^state_(\d+)\.sqlite$/

export type CodexStateDbBackfillStatus =
  | { kind: 'complete'; stateDbPath: string }
  | { kind: 'incomplete'; stateDbPath: string; status: string }
  | { kind: 'missing' }
  | { kind: 'not-tracked'; stateDbPath: string }
  | { kind: 'unreadable'; stateDbPath: string; error: string }

export function findNewestCodexStateDbPath(codexHomePath: string, strict = false): string | null {
  let entries: string[]
  try {
    entries = readdirSync(codexHomePath)
  } catch (error) {
    if (strict) {
      throw error
    }
    return null
  }
  let newest: { version: number; name: string } | null = null
  for (const name of entries) {
    const match = STATE_DB_FILE_PATTERN.exec(name)
    if (!match) {
      continue
    }
    const version = Number(match[1])
    if (!newest || version > newest.version) {
      newest = { version, name }
    }
  }
  return newest ? join(codexHomePath, newest.name) : null
}

export function readCodexStateDbBackfillStatus(codexHomePath: string): CodexStateDbBackfillStatus {
  const stateDbPath = findNewestCodexStateDbPath(codexHomePath)
  if (!stateDbPath) {
    return { kind: 'missing' }
  }
  let db: SyncDatabase | null = null
  try {
    db = new SyncDatabase(stateDbPath, { readonly: true, fileMustExist: true })
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backfill_state'")
      .get()
    if (!table) {
      return { kind: 'not-tracked', stateDbPath }
    }
    const row = db.prepare('SELECT status FROM backfill_state WHERE id = 1').get() as
      | { status?: unknown }
      | undefined
    if (!row || typeof row.status !== 'string') {
      return { kind: 'not-tracked', stateDbPath }
    }
    return row.status === 'complete'
      ? { kind: 'complete', stateDbPath }
      : { kind: 'incomplete', stateDbPath, status: row.status }
  } catch (error) {
    return {
      kind: 'unreadable',
      stateDbPath,
      error: error instanceof Error ? error.message : String(error)
    }
  } finally {
    try {
      db?.close()
    } catch {
      // A close failure cannot change the read-only result already collected.
    }
  }
}

/** Null means the database is absent or unreadable. */
export function readIndexedCodexThreadIds(codexHomePath: string): Set<string> | null {
  const stateDbPath = findNewestCodexStateDbPath(codexHomePath)
  if (!stateDbPath) {
    return null
  }
  let db: SyncDatabase | null = null
  try {
    db = new SyncDatabase(stateDbPath, { readonly: true, fileMustExist: true })
    const ids = new Set<string>()
    for (const row of db.prepare('SELECT id FROM threads').all()) {
      if (typeof row.id === 'string') {
        ids.add(row.id.toLowerCase())
      }
    }
    return ids
  } catch (error) {
    console.warn('[codex-state-db] Failed to read indexed Codex threads:', error)
    return null
  } finally {
    try {
      db?.close()
    } catch {
      // A close failure cannot change the read-only result already collected.
    }
  }
}

/** An absent index may use rollout metadata; an unreadable index must not certify a resume. */
export function readIndexedCodexThreadProvider(
  codexHomePath: string,
  sessionId: string
): string | null {
  const stateDbPath = findNewestCodexStateDbPath(codexHomePath, true)
  if (!stateDbPath) {
    return null
  }
  const db = new SyncDatabase(stateDbPath, { readonly: true, fileMustExist: true, timeout: 100 })
  try {
    const row = db
      .prepare('SELECT model_provider FROM threads WHERE id = ?')
      .get(sessionId.toLowerCase())
    if (!row) {
      return null
    }
    if (typeof row.model_provider !== 'string' || !row.model_provider) {
      throw new Error('Codex session index has no verifiable model provider')
    }
    return row.model_provider
  } finally {
    db.close()
  }
}

export function countCodexSessionFilesUpTo(sessionsRoot: string, limit: number): number {
  let count = 0
  const pendingDirectories = [sessionsRoot]
  while (pendingDirectories.length > 0 && count < limit) {
    const directory = pendingDirectories.pop() as string
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        pendingDirectories.push(join(directory, entry.name))
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zst'))
      ) {
        count += 1
        if (count >= limit) {
          break
        }
      }
    }
  }
  return count
}

export const BACKFILL_PENDING_MIN_SESSION_FILES = 100

export type CodexStateDbBackfillPendingState = 'pending' | 'not-pending' | 'unreadable'

export function readCodexStateDbBackfillPendingState(
  codexHomePath: string
): CodexStateDbBackfillPendingState {
  const status = readCodexStateDbBackfillStatus(codexHomePath)
  if (status.kind === 'incomplete') {
    return 'pending'
  }
  if (status.kind === 'unreadable') {
    return 'unreadable'
  }
  if (status.kind !== 'missing' && status.kind !== 'not-tracked') {
    return 'not-pending'
  }
  return countCodexSessionFilesUpTo(
    join(codexHomePath, 'sessions'),
    BACKFILL_PENDING_MIN_SESSION_FILES
  ) >= BACKFILL_PENDING_MIN_SESSION_FILES
    ? 'pending'
    : 'not-pending'
}

export function isCodexStateDbBackfillPending(codexHomePath: string): boolean {
  return readCodexStateDbBackfillPendingState(codexHomePath) === 'pending'
}
