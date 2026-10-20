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

/**
 * Lower-cased thread ids already in Codex's state DB, or null when the DB is
 * missing or unreadable. Read-only; never creates or mutates Codex's database.
 */
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

/**
 * Each thread's current rollout file name, as Codex's state DB selects it, or
 * null when the DB is missing or unreadable. For a paginated thread this row,
 * not the newest file, is what `codex resume` opens. Read-only.
 */
export function readCodexThreadRolloutFileNames(
  sqliteHome: string,
  onlyThreadId?: string
): Map<string, string> | null {
  const stateDbPath = findNewestCodexStateDbPath(sqliteHome)
  if (!stateDbPath) {
    return null
  }
  let db: SyncDatabase | null = null
  try {
    db = new SyncDatabase(stateDbPath, { readonly: true, fileMustExist: true })
    const fileNames = new Map<string, string>()
    const rows = onlyThreadId
      ? db.prepare('SELECT id, rollout_path FROM threads WHERE id = ?').all(onlyThreadId)
      : db.prepare('SELECT id, rollout_path FROM threads').all()
    for (const row of rows) {
      if (typeof row.id === 'string' && typeof row.rollout_path === 'string') {
        const fileName = row.rollout_path
          .split(/[\\/]/)
          .at(-1)
          ?.replace(/\.zst$/, '')
        if (fileName) {
          fileNames.set(row.id.toLowerCase(), fileName)
        }
      }
    }
    return fileNames
  } catch (error) {
    console.warn('[codex-state-db] Failed to read Codex thread rollout paths:', error)
    return null
  } finally {
    try {
      db?.close()
    } catch {
      // A close failure cannot change the read-only result already collected.
    }
  }
}

export type CodexThreadPlacement = {
  fileName: string
  sectionId: string | null
  sectionName: string | null
  position: number | null
  enteredAtMs: number | null
}

/** Each thread's selected rollout and sidebar section, read-only; sections are absent on older schemas. */
export function readCodexThreadPlacements(
  sqliteHome: string
): Map<string, CodexThreadPlacement> | null {
  const stateDbPath = findNewestCodexStateDbPath(sqliteHome)
  if (!stateDbPath) {
    return null
  }
  let db: SyncDatabase | null = null
  try {
    db = new SyncDatabase(stateDbPath, { readonly: true, fileMustExist: true })
    const hasSections = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_sections'")
      .get()
    const rows = hasSections
      ? db
          .prepare(
            `SELECT t.id, t.rollout_path, t.thread_section_id AS section_id, s.name AS section_name,
                    t.section_position AS position, t.section_entered_at_ms AS entered_at_ms
             FROM threads t LEFT JOIN thread_sections s ON s.id = t.thread_section_id`
          )
          .all()
      : db.prepare('SELECT id, rollout_path FROM threads').all()
    const placements = new Map<string, CodexThreadPlacement>()
    for (const row of rows) {
      const fileName =
        typeof row.rollout_path === 'string'
          ? row.rollout_path
              .split(/[\\/]/)
              .at(-1)
              ?.replace(/\.zst$/, '')
          : undefined
      if (typeof row.id === 'string' && fileName) {
        placements.set(row.id.toLowerCase(), {
          fileName,
          sectionId: typeof row.section_id === 'string' ? row.section_id : null,
          sectionName: typeof row.section_name === 'string' ? row.section_name : null,
          position: typeof row.position === 'number' ? row.position : null,
          enteredAtMs: typeof row.entered_at_ms === 'number' ? row.entered_at_ms : null
        })
      }
    }
    return placements
  } catch (error) {
    console.warn('[codex-state-db] Failed to read Codex thread placements:', error)
    return null
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
      } else if (
        entry.isFile() &&
        // Why: Codex's startup backfill parses compressed rollouts too.
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

/** `unreadable` means the index could not be read, so the caller picks its own safe side. */
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
