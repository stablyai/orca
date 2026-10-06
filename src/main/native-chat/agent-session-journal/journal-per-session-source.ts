// Reading a chat's per-chat journal file, the one each chat had before the host's one database.
// The importer copies through this reader, and a restore folds through it without copying.

import { rmdirSync, rmSync } from 'node:fs'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import Database from '../../sqlite/sync-database'
import { startJournalRowFold, type JournalLoad } from './journal-open'
import { legacyJournalDatabaseFile } from './journal-paths'
import type { PerSessionJournalHead } from './journal-per-session-reimport'

/** The newest per-chat file shape any build wrote. */
const LEGACY_JOURNAL_SCHEMA_VERSION = 2
/** Rows per batch: at most 31 ms per batch copying the largest real chat (68 MB, 3.3 KB rows). */
export const IMPORT_BATCH_ROWS = 512

const SELECT_LEGACY_EPOCH = 'SELECT epoch FROM journal_sessions WHERE session_id = ?'
const SELECT_LEGACY_TIP =
  'SELECT max(seq) AS tip FROM journal_rows WHERE session_id = ? AND epoch = ?'
const SELECT_LEGACY_ROWS = `SELECT seq, ts, row_json FROM journal_rows
WHERE session_id = ? AND epoch = ? AND seq > ? ORDER BY seq ASC LIMIT ?`
const HAS_LEGACY_TABLE = "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?"

type ImportedRow = { seq: number; ts: number; rowJson: string }
export type ImportBatch = { rows: ImportedRow[]; last: boolean }

/** A plain read-only connection: it sees committed WAL frames without checkpointing them. */
export function openLegacySource(path: string): Database.Database {
  const source = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const version = Number(source.pragma('user_version', { simple: true }) ?? 0)
    if (version > LEGACY_JOURNAL_SCHEMA_VERSION) {
      throw new Error(`per-chat journal ${path} uses schema ${version}, which no build wrote`)
    }
    return source
  } catch (error) {
    source.close()
    throw error
  }
}

export function readLegacyHead(
  source: Database.Database,
  sessionId: string
): PerSessionJournalHead | null {
  // Created but never given its schema (a crash between the two): no history, as an empty file.
  if (!source.prepare(HAS_LEGACY_TABLE).get('journal_sessions')) {
    return null
  }
  const epoch = source.prepare(SELECT_LEGACY_EPOCH).get(sessionId)?.epoch
  if (typeof epoch !== 'string' || epoch.length === 0) {
    return null
  }
  const tip = source.prepare(SELECT_LEGACY_TIP).get(sessionId, epoch)?.tip
  return { epoch, tip: typeof tip === 'number' ? tip : 0 }
}

/** The file's rows, one bounded page per batch, read as each batch is written. */
export function* legacyRowBatches(
  source: Database.Database,
  sessionId: string,
  epoch: string,
  batchRows: number
): Generator<ImportBatch> {
  const select = source.prepare(SELECT_LEGACY_ROWS)
  let afterSeq = Number.MIN_SAFE_INTEGER
  for (;;) {
    const rows = select
      .all(sessionId, epoch, afterSeq, batchRows)
      .map((row) => ({ seq: Number(row.seq), ts: Number(row.ts), rowJson: String(row.row_json) }))
    const lastSeq = rows.at(-1)?.seq
    const last = rows.length < batchRows || lastSeq === undefined
    yield { rows, last }
    if (last) {
      return
    }
    afterSeq = lastSeq
  }
}

/** The chat as its file holds it, folded the way a replay folds the host's database. */
export async function foldLegacyJournal(
  source: Database.Database,
  sessionId: string,
  legacy: PerSessionJournalHead
): Promise<JournalLoad> {
  const fold = startJournalRowFold({ sessionId, epoch: legacy.epoch })
  let first = true
  for (const batch of legacyRowBatches(source, sessionId, legacy.epoch, IMPORT_BATCH_ROWS)) {
    // A batch per turn: a large chat's file read in one task holds up everything else at startup.
    if (!first) {
      await yieldToEventLoop()
    }
    first = false
    if (!batch.rows.every(fold.add)) {
      break
    }
  }
  return fold.finish()
}

/**
 * Deletes the per-chat file and SQLite's WAL files beside it, then the directory if nothing else is
 * in it: a pre-SQLite transcript there is the user's, and stays. Its connection must be closed.
 * Best effort: the copy is committed, so a file left behind is deleted by the next open.
 */
export function retireLegacyJournal(
  legacyDirectory: string,
  remove: (path: string) => void = (path) => rmSync(path, { force: true })
): void {
  const file = legacyJournalDatabaseFile(legacyDirectory)
  try {
    // The database first: a WAL left without it is never read, but a database left without its WAL
    // would read back short of the tip it was copied at, and be set aside rather than deleted.
    for (const path of [file, `${file}-wal`, `${file}-shm`]) {
      remove(path)
    }
  } catch (error) {
    console.warn(`[agent-session-journal] deleting imported ${legacyDirectory} failed`, error)
    return
  }
  try {
    rmdirSync(legacyDirectory)
  } catch {
    // Not empty: something beside the journal is kept.
  }
}
