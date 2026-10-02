// Copying a chat's per-chat journal file into the host's one database: on that chat's open, or
// from the background copy (structured-agent-session-per-chat-file-copy.ts).
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
// imported all at once or not at all. A try that stops midway (a quit, a crash) leaves only
// unpublished rows, which the next try deletes, a batch per task, before it copies again. A copy
// that does not read back as the file is never published: the file stays, and the chat is refused
// as unreadable.
//
// Only after that commit is the file deleted, its connection closed first, and only while it is
// still as it stood before the verify read it. A read that fails leaves the file where it is for
// the next open, and the open is refused rather than served empty: an empty chat founded here would
// take a new epoch the next open's import could not reconcile. A file that was never written holds no
// history and is deleted whenever it is found.

import {
  deriveJournalSessionStatus,
  writeJournalSessionStatus,
  type JournalSessionStatus
} from './journal-session-state'
import { existsSync } from 'node:fs'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import { deleteJournalBackgroundFailure } from './journal-background-failures'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalLoad } from './journal-open'
import { legacyJournalDatabaseFile } from './journal-paths'
import { assertImportNotAborted, verifyCopiedJournal } from './journal-per-session-copy-check'
import {
  planPerSessionImport,
  isPerSessionJournalSetAside,
  readPerSessionImportMarker,
  setAsidePerSessionJournal,
  writePerSessionImportMarker,
  type PerSessionImportPlan,
  type PerSessionJournalHead
} from './journal-per-session-reimport'
import { charBoundedBatches, IMPORT_BATCH_CHARS } from './journal-session-status-backfill'
import { wholeJournalImportPages, type JournalImportPages } from './journal-import-page'
import {
  foldLegacyJournal,
  IMPORT_BATCH_ROWS,
  IMPORT_COMMIT_CHARS,
  legacyRowBatches,
  openLegacySource,
  readLegacyHead,
  readLegacyRepair,
  readLegacyRowsAfter,
  retireLegacyJournal,
  samePerChatFileState,
  statPerChatFile,
  type PerChatFileState
} from './journal-per-session-source'
import {
  deleteUnpublishedJournalRows,
  publishJournalSessionEpoch,
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
  /** Rows per page: every page by default, the most a timed page takes (journal-import-page.ts). */
  batchRows?: number
  /** Row JSON per verify batch; see `IMPORT_BATCH_CHARS`. */
  batchChars?: number
  /** Row JSON per copy commit; see `IMPORT_COMMIT_CHARS`. */
  commitChars?: number
  /** Ends each of the copy's tasks: the next macrotask by default; the background copy paces here. */
  yieldTask?: () => Promise<void>
  /** The copy's pages: whole by default; the background copy's work sizes them by time. */
  pages?: JournalImportPages
  /** Stops the copy at its next batch, publishing nothing; the chat stays owed. */
  signal?: AbortSignal
}

export type PerSessionJournalImportOutcome = 'absent' | 'imported' | 'already-imported' | 'kept'

export type PerSessionJournalImport = {
  outcome: PerSessionJournalImportOutcome
  /** `imported` only: the copy's own fold, exactly what a replay of the published chat returns. */
  load?: JournalLoad
  /** `imported` only: the status row the publish wrote from that fold; none for a corrupt history,
   *  which gets no row so its open rebuilds it (as the startup pass leaves one). */
  status?: JournalSessionStatus
}

type ImportInput = {
  database: JournalHostDatabase
  identity: AgentSessionJournalIdentity
  legacyDirectory: string
} & PerSessionJournalImportDeps

/** Imports in flight, by database and chat: a second open of the same chat waits for the first. */
const importsInFlight = new WeakMap<JournalHostDatabase, Map<string, Promise<unknown>>>()

export function importPerSessionJournal(input: ImportInput): Promise<PerSessionJournalImport> {
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

async function importOnce(input: ImportInput): Promise<PerSessionJournalImport> {
  // A copy stopped before its turn (behind another import of the chat) opens nothing.
  if (input.signal) {
    assertImportNotAborted(input.database, input.identity.sessionId, input.signal)
  }
  const sourcePath = legacyJournalDatabaseFile(input.legacyDirectory)
  if (!existsSync(sourcePath)) {
    return { outcome: 'absent' }
  }
  const { sessionId } = input.identity
  if (isPerSessionJournalSetAside(input.database.db, sessionId)) {
    return { outcome: 'kept' }
  }
  const published = readJournalSessionEpoch(input.database.db, sessionId) !== null
  const source = (input.openSource ?? openLegacySource)(sourcePath)
  let legacy: PerSessionJournalHead | null
  let plan: PerSessionImportPlan | null = null
  let copied: CopiedJournal | null = null
  try {
    legacy = readLegacyHead(source, sessionId)
    if (legacy) {
      plan = planPerSessionImport({ db: input.database.db, sessionId, legacy, published })
      if (plan.kind === 'first') {
        copied = await copyLegacyJournal(input, source, legacy)
      }
    }
  } finally {
    source.close()
  }
  if (!legacy) {
    // Never written: no history, so nothing to copy. A pre-SQLite transcript beside it stays, and
    // the chat's open still finds it there (the directory goes only once it is empty).
    retireLegacyJournal(input.legacyDirectory, input.remove)
    return { outcome: published ? 'already-imported' : 'absent' }
  }
  if (plan?.kind === 'kept') {
    setAsidePerSessionJournal(input.database.db, sessionId, legacy)
    return { outcome: 'kept' }
  }
  if (
    copied &&
    !samePerChatFileState(copied.verifiedFile, statPerChatFile(input.legacyDirectory))
  ) {
    // Written since the verify began (an older build on a shared profile): kept, so its next try
    // finds a head past the import marker and sets it aside rather than losing those rows.
    console.warn(`[agent-session-journal] ${input.legacyDirectory} changed after its copy; kept`)
  } else {
    // Also a file a crash left after its copy was recorded (`copied`): deleted now, not copied again.
    retireLegacyJournal(input.legacyDirectory, input.remove)
  }
  if (!copied) {
    return { outcome: 'already-imported' }
  }
  // The open's replay of what was just copied is a long task of its own; don't add this one to it.
  await (input.yieldTask ?? yieldToEventLoop)()
  return {
    outcome: 'imported',
    load: copied.load,
    ...(copied.status ? { status: copied.status } : {})
  }
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

/** What a first copy hands back: its load and the status it published, and the file as it stood
 *  before the verify read it. */
type CopiedJournal = {
  load: JournalLoad
  status: JournalSessionStatus | null
  verifiedFile: PerChatFileState | null
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
): Promise<CopiedJournal> {
  const { sessionId } = input.identity
  const { epoch } = legacy
  const repair = readLegacyRepair(source, sessionId)
  const batchChars = input.batchChars ?? IMPORT_BATCH_CHARS
  const page = (input.pages ?? wholeJournalImportPages)(
    input.batchRows ?? IMPORT_BATCH_ROWS,
    input.yieldTask ?? (() => yieldToEventLoop())
  )
  const yieldTask = page.yieldTask
  // What an earlier try that stopped midway left, a page per task as the copy's own rows go in.
  for (;;) {
    assertImportNotAborted(input.database, sessionId, input.signal)
    const want = page.rows
    const deleted = input.database.unsyncedTransaction((db) =>
      deleteUnpublishedJournalRows(db, sessionId, want)
    )
    if (deleted === 0) {
      break
    }
    await yieldTask()
    if (deleted < want) {
      break
    }
  }
  // Each page is read in a task, and written in a task of its own.
  for (let afterSeq = Number.MIN_SAFE_INTEGER, first = true; ; first = false) {
    if (!first) {
      await yieldTask()
    }
    assertImportNotAborted(input.database, sessionId, input.signal)
    const want = page.rows
    const rows = readLegacyRowsAfter(source, sessionId, epoch, afterSeq, want)
    for (const part of charBoundedBatches(
      [{ rows, last: true }],
      input.commitChars ?? IMPORT_COMMIT_CHARS
    )) {
      await yieldTask()
      assertImportNotAborted(input.database, sessionId, input.signal)
      // Unsynced: no reader follows these rows, and the publish's synced commit covers them.
      input.database.unsyncedTransaction((db) => {
        const insert = db.prepare(INSERT_ROW)
        for (const row of part.rows) {
          // Copied as stored: the bytes are the row, its epoch and sequence included.
          insert.run(sessionId, epoch, row.seq, row.ts, row.rowJson)
        }
      })
    }
    const last = rows.at(-1)
    if (!last || rows.length < want) {
      break
    }
    afterSeq = last.seq
  }
  // Each step of the copy is a task of its own: the last page, the verify, the publish.
  await yieldTask()
  // Before the verify reads the file: a write after this is either read by it (a mismatch, never
  // published) or changes the file from this (kept).
  const verifiedFile = statPerChatFile(input.legacyDirectory)
  const load = await verifyCopiedJournal(
    {
      database: input.database,
      sessionId,
      epoch,
      repairedFrom: repair?.epoch === epoch ? Number(repair.content_from) : null,
      batchRows: () => page.rows,
      batchChars,
      legacyDirectory: input.legacyDirectory,
      yieldTask,
      ...(input.signal ? { signal: input.signal } : {})
    },
    charBoundedBatches(
      legacyRowBatches(source, sessionId, epoch, () => page.rows),
      batchChars
    )
  )
  await yieldTask()
  assertImportNotAborted(input.database, sessionId, input.signal)
  // A corrupt history gets no row, as the startup pass leaves one, so its open rebuilds it.
  const status = load.corrupt
    ? null
    : deriveJournalSessionStatus(load.state, { settlesRosters: true })
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
    deleteJournalBackgroundFailure(db, { sessionId, step: 'copy' })
    // From the copy's own fold, which is what a replay of these rows reads: no second fold here.
    if (status) {
      writeJournalSessionStatus(db, sessionId, status)
    }
  })
  return { load, status, verifiedFile }
}
