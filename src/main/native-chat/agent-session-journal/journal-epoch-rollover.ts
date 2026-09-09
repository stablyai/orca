// Opening a new epoch.
//
// One transaction: discard every row of the superseded epoch, insert the new
// epoch row at sequence 1, move the session projection onto it, and retire any
// repair marker the superseded epoch was carrying. Superseded rows are DELETED
// rather than retained — nothing would ever shed them.

import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import type { AgentSessionProviderHandle } from '../../../shared/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import type { JournalLoad } from './journal-open'
import { clearJournalRepairMarker } from './journal-repair-marker'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import {
  deleteAllJournalRows,
  insertJournalRow,
  upsertJournalSessionRow
} from './journal-row-table'
import type { AgentJournalEpochReason, JournalRow } from './journal-row-schema'

export function publishNewEpoch(input: {
  db: Database.Database
  sessionId: string
  providerHandle: AgentSessionProviderHandle
  epoch: string
  reason: AgentJournalEpochReason
  fence: number
  now: number
  /** Called the instant the transaction commits, before any fallible follow-up. */
  onPublished: (loaded: JournalLoad) => void
}): void {
  const row: JournalRow = {
    kind: 'epoch',
    reason: input.reason,
    providerHandle: input.providerHandle,
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: input.epoch,
    seq: 1,
    fence: input.fence,
    ts: input.now
  }

  input.db.exec('BEGIN IMMEDIATE')
  try {
    deleteAllJournalRows(input.db)
    clearJournalRepairMarker(input.db, input.sessionId)
    insertJournalRow(input.db, input.sessionId, row)
    upsertJournalSessionRow(input.db, input.sessionId, input.epoch, input.now)
    input.db.exec('COMMIT')
  } catch (error) {
    input.db.exec('ROLLBACK')
    throw error
  }

  // COMMIT landed: on disk the superseded prefix is gone and this epoch is the
  // live one. The caller adopts that immediately, or a later failure leaves the
  // store writing into an epoch that no longer exists.
  const state = createJournalReducerState(input.sessionId, input.epoch)
  applyJournalRow(state, row)
  state.oldestSequence = 1
  input.onPublished({ state, readOnly: false, corrupt: false, malformedRows: 0 })
}
