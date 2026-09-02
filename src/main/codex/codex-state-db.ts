import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'

const STATE_DB_FILE_PATTERN = /^state_(\d+)\.sqlite$/

export type CodexStateDbBackfillStatus =
  | { kind: 'complete'; stateDbPath: string }
  | { kind: 'incomplete'; stateDbPath: string; status: string }
  | { kind: 'missing' }
  | { kind: 'not-tracked'; stateDbPath: string }
  | { kind: 'unreadable'; stateDbPath: string; error: string }

export function findNewestCodexStateDbPath(codexHomePath: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(codexHomePath)
  } catch {
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

/** Reads Codex-owned backfill metadata without creating or mutating its database. */
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
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
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

export function isCodexStateDbBackfillPending(codexHomePath: string): boolean {
  const status = readCodexStateDbBackfillStatus(codexHomePath)
  if (status.kind === 'incomplete') {
    return true
  }
  if (status.kind !== 'missing' && status.kind !== 'not-tracked') {
    return false
  }
  return (
    countCodexSessionFilesUpTo(
      join(codexHomePath, 'sessions'),
      BACKFILL_PENDING_MIN_SESSION_FILES
    ) >= BACKFILL_PENDING_MIN_SESSION_FILES
  )
}
