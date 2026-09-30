// Copying a chat's per-chat journal file into the host's one database, on that chat's open.
//
// Not `journal-legacy-import.ts`, which reads the PROVIDER's own transcript. This reads Orca's own
// earlier `<legacyDir>/journal.db`, verbatim: the same epoch UUID and every sequence number, so a
// cursor, an `acceptedSequence` or a restart offer taken before the upgrade still points at the
// same row after it. A file that reappears after a downgrade is set aside, never read again (see
// journal-per-session-reimport.ts).
//
// The copy runs in bounded batches, each its own transaction, yielding the event loop between them.
// The rows go in under the file's epoch, which the chat's pointer does not name yet, so no reader
// sees them. Once they read back as the file does (every row's sequence, time and bytes), one
// transaction publishes the chat's pointer with its repair and import markers, so the chat is
// imported all at once or not at all. A try that stops midway leaves only unpublished rows, which
// the next try deletes before it copies again. A copy that does not read back as the file is never
// published: the file stays, and the chat is refused as unreadable.
//
// Only after that commit is the file deleted, its connection closed first. A read that fails
// leaves the file where it is for the next open, and the open is refused rather than served empty:
// an empty chat founded here would take a new epoch the next open's import could not reconcile.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalLoad } from './journal-open'
import { JournalImportMismatchError, journalOpenRefusalError } from './journal-open-failure'
import { legacyJournalDatabaseFile } from './journal-paths'
import {
  planPerSessionImport,
  isPerSessionJournalSetAside,
  readPerSessionImportMarker,
  setAsidePerSessionJournal,
  writePerSessionImportMarker,
  type PerSessionImportPlan,
  type PerSessionJournalHead
} from './journal-per-session-reimport'
import {
  foldLegacyJournal,
  IMPORT_BATCH_ROWS,
  legacyRowBatches,
  openLegacySource,
  readLegacyHead,
  readLegacyRepair,
  retireLegacyJournal,
  type ImportBatch
} from './journal-per-session-source'
import { parseJournalRow } from './journal-row-schema'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import {
  deleteUnpublishedJournalRows,
  publishJournalSessionEpoch,
  readJournalRowsAfter,
  readJournalSessionEpoch
} from './journal-row-table'

const INSERT_ROW =
  'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
const UPSERT_REPAIR = `INSERT INTO journal_repairs (session_id, epoch, content_from, repaired_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  epoch = excluded.epoch, content_from = excluded.content_from, repaired_at = excluded.repaired_at`

type PerSessionJournalImportDeps = {
  openSource?: (path: string) => Database.Database
  /** Deletes one of the per-chat files. */
  remove?: (path: string) => void
  batchRows?: number
}

export type PerSessionJournalImportOutcome = 'absent' | 'imported' | 'already-imported' | 'kept'

type ImportInput = {
  database: JournalHostDatabase
  identity: AgentSessionJournalIdentity
  legacyDirectory: string
} & PerSessionJournalImportDeps

/** Imports in flight, by database and chat: a second open of the same chat waits for the first. */
const importsInFlight = new WeakMap<JournalHostDatabase, Map<string, Promise<unknown>>>()

export function importPerSessionJournal(
  input: ImportInput
): Promise<PerSessionJournalImportOutcome> {
  let inFlight = importsInFlight.get(input.database)
  if (!inFlight) {
    inFlight = new Map()
    importsInFlight.set(input.database, inFlight)
  }
  const { sessionId } = input.identity
  const run = (inFlight.get(sessionId) ?? Promise.resolve()).then(() => importOnce(input))
  const settled = run.catch(() => undefined)
  inFlight.set(sessionId, settled)
  void settled.then(() => {
    if (inFlight.get(sessionId) === settled) {
      inFlight.delete(sessionId)
    }
  })
  return run
}

async function importOnce(input: ImportInput): Promise<PerSessionJournalImportOutcome> {
  const sourcePath = legacyJournalDatabaseFile(input.legacyDirectory)
  if (!existsSync(sourcePath)) {
    return 'absent'
  }
  const { sessionId } = input.identity
  if (isPerSessionJournalSetAside(input.database.db, sessionId)) {
    return 'kept'
  }
  const published = readJournalSessionEpoch(input.database.db, sessionId) !== null
  const source = (input.openSource ?? openLegacySource)(sourcePath)
  let legacy: PerSessionJournalHead | null
  let plan: PerSessionImportPlan | null = null
  try {
    legacy = readLegacyHead(source, sessionId)
    if (legacy) {
      plan = planPerSessionImport({ db: input.database.db, sessionId, legacy, published })
      if (plan.kind === 'first') {
        await copyLegacyJournal(input, source, legacy)
      }
    }
  } finally {
    source.close()
  }
  if (!legacy) {
    // Never written. Left in place while its chat is unfounded: that open's empty chat may still
    // owe the notice about a pre-SQLite transcript beside it.
    if (!published) {
      return 'absent'
    }
    retireLegacyJournal(input.legacyDirectory, input.remove)
    return 'already-imported'
  }
  if (plan?.kind === 'kept') {
    setAsidePerSessionJournal(input.database.db, sessionId, legacy)
    return 'kept'
  }
  // Also a file a crash left after its copy was recorded (`copied`): deleted now, not copied again.
  retireLegacyJournal(input.legacyDirectory, input.remove)
  if (plan?.kind === 'copied') {
    return 'already-imported'
  }
  // The open's replay of what was just copied is a long task of its own; don't add this one to it.
  await yieldToEventLoop()
  return 'imported'
}

/**
 * The chat a first copy would import, folded straight from its per-chat file and copying nothing:
 * for a restore, which must not import. Null when the open has to import now instead: the chat is
 * already in the host's database or was copied before (the reimport rules decide), its file holds
 * no chat, or its fold needs a repair written. The file is closed before this returns.
 */
export async function previewPerSessionJournal(
  input: Pick<ImportInput, 'database' | 'identity' | 'legacyDirectory' | 'openSource'>
): Promise<JournalLoad | null> {
  const { sessionId } = input.identity
  const db = input.database.db
  const sourcePath = legacyJournalDatabaseFile(input.legacyDirectory)
  if (
    readJournalSessionEpoch(db, sessionId) !== null ||
    readPerSessionImportMarker(db, sessionId) ||
    !existsSync(sourcePath)
  ) {
    return null
  }
  const source = (input.openSource ?? openLegacySource)(sourcePath)
  try {
    const legacy = readLegacyHead(source, sessionId)
    if (!legacy) {
      return null
    }
    const loaded = await foldLegacyJournal(source, sessionId, legacy)
    return loaded.corrupt || loaded.readOnly || loaded.truncateFrom !== undefined ? null : loaded
  } finally {
    source.close()
  }
}

/**
 * Batches under the file's epoch, which no reader follows until the chat's pointer names it. Once
 * the rows read back as the file does, one transaction publishes the pointer with the chat's repair
 * marker and the import marker.
 */
async function copyLegacyJournal(
  input: ImportInput,
  source: Database.Database,
  legacy: PerSessionJournalHead
): Promise<void> {
  const { sessionId } = input.identity
  const { epoch } = legacy
  const repair = readLegacyRepair(source, sessionId)
  const batchRows = input.batchRows ?? IMPORT_BATCH_ROWS
  let first = true
  for (const batch of legacyRowBatches(source, sessionId, epoch, batchRows)) {
    if (!first) {
      await yieldToEventLoop()
    }
    // Unsynced: no reader follows these rows, and the publish's synced commit covers them.
    input.database.unsyncedTransaction((db) => {
      if (first) {
        // What an earlier try that stopped midway left.
        deleteUnpublishedJournalRows(db, sessionId)
      }
      const insert = db.prepare(INSERT_ROW)
      for (const row of batch.rows) {
        // Copied as stored: the bytes are the row, its epoch and sequence included.
        insert.run(sessionId, epoch, row.seq, row.ts, row.rowJson)
      }
    })
    first = false
  }
  await verifyCopiedJournal(input, legacyRowBatches(source, sessionId, epoch, batchRows), epoch)
  input.database.transaction((db) => {
    publishJournalSessionEpoch(db, input.identity, epoch)
    if (repair) {
      db.prepare(UPSERT_REPAIR).run(
        sessionId,
        repair.epoch,
        repair.content_from,
        repair.repaired_at
      )
    }
    writePerSessionImportMarker(db, sessionId, legacy)
  })
}

/** Mismatches already logged, so a chat refused on every open logs once. */
const loggedMismatches = new Set<string>()

/**
 * The copied rows, read back from the host's database, against a second read of what was copied:
 * the same rows, byte for byte, and the same epoch, tip, row count, items and submissions, or the
 * copy is refused and never published. Both reads go a batch at a time, so no check holds the main
 * thread longer than a copy batch does.
 */
async function verifyCopiedJournal(
  input: ImportInput,
  expected: Iterable<ImportBatch>,
  epoch: string
): Promise<void> {
  const { sessionId } = input.identity
  const want = await copyFacts(sessionId, expected)
  const got = await copyFacts(sessionId, copiedBatches(input, epoch))
  if (want === got) {
    return
  }
  const error = new JournalImportMismatchError(
    `per-chat journal of ${sessionId} read back as ${got} after its copy, not ${want}`
  )
  if (!loggedMismatches.has(`${sessionId}\n${want}\n${got}`)) {
    loggedMismatches.add(`${sessionId}\n${want}\n${got}`)
    console.error(`[agent-session-journal] ${error.message}; ${input.legacyDirectory} is kept`)
  }
  throw journalOpenRefusalError(error)
}

/** Epoch, tip, row count, items, submissions and a digest of every row, folded a batch at a time. */
async function copyFacts(sessionId: string, batches: Iterable<ImportBatch>): Promise<string> {
  const state = createJournalReducerState(sessionId, '')
  const content = createHash('sha256')
  let epoch: string | null = null
  let tip = 0
  let rows = 0
  let first = true
  for (const batch of batches) {
    if (!first) {
      await yieldToEventLoop()
    }
    first = false
    rows += batch.rows.length
    for (const row of batch.rows) {
      tip = Math.max(tip, row.seq)
      // Length-framed, so no two different rows hash the same stream.
      content.update(`${row.seq}:${row.ts}:${row.rowJson.length}:`).update(row.rowJson)
      const parsed = parseJournalRow(row.rowJson)
      if (parsed.ok) {
        epoch ??= parsed.row.epoch
        applyJournalRow(state, parsed.row)
      }
    }
  }
  return `${epoch}:${tip}:${rows}:${state.items.size}:${state.submissions.size}:${content.digest('hex')}`
}

function* copiedBatches(input: ImportInput, epoch: string): Generator<ImportBatch> {
  const { sessionId } = input.identity
  const batchRows = input.batchRows ?? IMPORT_BATCH_ROWS
  let afterSeq = Number.MIN_SAFE_INTEGER
  for (;;) {
    const rows = readJournalRowsAfter(input.database.db, sessionId, epoch, afterSeq, batchRows)
    const lastSeq = rows.at(-1)?.seq
    const last = rows.length < batchRows || lastSeq === undefined
    yield { rows, last }
    if (last) {
      return
    }
    afterSeq = lastSeq
  }
}
