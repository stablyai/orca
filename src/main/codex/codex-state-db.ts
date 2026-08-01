import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'

// Why: Codex versions its state DB filename per schema (state_5.sqlite today); never hardcode the number.
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
  let best: { version: number; name: string } | null = null
  for (const name of entries) {
    const match = STATE_DB_FILE_PATTERN.exec(name)
    if (!match) {
      continue
    }
    const version = Number(match[1])
    if (!best || version > best.version) {
      best = { version, name }
    }
  }
  return best ? join(codexHomePath, best.name) : null
}

/**
 * Reads Codex's session-index backfill status from the newest state DB in the
 * given Codex home. Strictly read-only: never creates, writes, or repairs the
 * DB (#11830 covers corruption from interrupted indexes; we must not add to it).
 */
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
      // Why: close() failure must not mask the status we already computed.
    }
  }
}

/** Counts rollout .jsonl files under a sessions root, stopping early at `limit`. */
export function countCodexSessionFilesUpTo(sessionsRoot: string, limit: number): number {
  let count = 0
  const stack = [sessionsRoot]
  while (stack.length > 0 && count < limit) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (count >= limit) {
        break
      }
      if (entry.isDirectory()) {
        stack.push(join(dir, entry.name))
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        count += 1
      }
    }
  }
  return count
}
