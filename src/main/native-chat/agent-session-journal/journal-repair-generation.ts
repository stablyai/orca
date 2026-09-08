import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import { replayJournal, type JournalLoad } from './journal-open'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { writeJournalRepairMarker } from './journal-repair-marker'
import { journalRowBase } from './journal-row-builders'
import { parseJournalRow, type JournalRow } from './journal-row-schema'
import {
  insertJournalRow,
  readJournalEpochRows,
  upsertJournalSessionRow
} from './journal-row-table'

/** Sealing, prefix admission, and publication share the journal's FULL-sync transaction. */
export function repairJournalGeneration(input: {
  db: Database.Database
  identity: AgentSessionJournalIdentity
  loaded: JournalLoad
  epoch: string
  now: number
  onPublished: (loaded: JournalLoad) => void
}): void {
  const { db, identity, epoch, now } = input
  const sessionId = identity.sessionId
  const state = createJournalReducerState(sessionId, epoch)
  db.exec('BEGIN IMMEDIATE')
  try {
    // Recheck under the write lock: a cached probe cannot authorize repairing another generation.
    const current = replayJournal(db, false, sessionId)
    if (
      !current ||
      current.readOnly ||
      epoch === current.state.epoch ||
      current.state.epoch !== input.loaded.state.epoch ||
      current.truncateFrom !== input.loaded.truncateFrom ||
      current.state.lastSequence !== input.loaded.state.lastSequence
    ) {
      throw new Error('Journal changed before repair admission')
    }
    const sourceEpoch = current.state.epoch
    const prefixThrough = current.state.lastSequence
    db.prepare(`INSERT INTO journal_recovery_epochs
      (session_id, epoch, replacement_epoch, rejected_from, prefix_through, sealed_at, row_count, row_bytes)
      SELECT ?, ?, ?, ?, ?, ?, count(*), coalesce(sum(length(CAST(row_json AS BLOB))), 0)
      FROM journal_rows WHERE session_id = ? AND epoch = ?`).run(
      sessionId,
      sourceEpoch,
      epoch,
      current.truncateFrom ?? 1,
      prefixThrough,
      now,
      sessionId,
      sourceEpoch
    )
    const rows: JournalRow[] = []
    for (const stored of readJournalEpochRows(db, sessionId, sourceEpoch)) {
      if (stored.seq > prefixThrough) {
        break
      }
      const parsed = parseJournalRow(stored.rowJson)
      if (!parsed.ok) {
        throw new Error('Journal prefix changed before repair admission')
      }
      rows.push({ ...parsed.row, epoch })
    }
    if (rows.length === 0) {
      rows.push({
        kind: 'epoch',
        reason: 'unreconcilable_prefix',
        providerHandle: identity.providerHandle,
        ...journalRowBase(epoch, 1, current.state.highestFence, now)
      })
    }
    for (const row of rows) {
      insertJournalRow(db, sessionId, row)
      applyJournalRow(state, row)
    }
    writeJournalRepairMarker(db, sessionId, epoch, state.lastSequence + 1, now)
    upsertJournalSessionRow(db, sessionId, epoch, now)
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) {
      db.exec('ROLLBACK')
    }
    throw error
  }
  input.onPublished({
    state,
    readOnly: false,
    corrupt: true,
    malformedRows: input.loaded.malformedRows
  })
}
