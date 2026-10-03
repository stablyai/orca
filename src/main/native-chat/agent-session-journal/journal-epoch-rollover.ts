// Opening a new epoch.
//
// One transaction: discard every row of the superseded epoch, insert the new
// epoch row at sequence 1, move the session projection onto it, retire any
// repair marker the superseded epoch was carrying, and write the chat's status for
// the new epoch. Superseded rows are DELETED rather than retained — nothing would
// ever shed them.

import { journalRowSchemaVersion } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalLoad } from './journal-open'
import { clearJournalRepairMarker } from './journal-repair-marker'
import type Database from '../../sqlite/sync-database'
import {
  applyJournalRow,
  createJournalReducerState,
  type JournalReducerState
} from './journal-reducer'
import {
  deleteJournalEpochRows,
  insertJournalRow,
  publishJournalSessionEpoch,
  readJournalSessionEpoch
} from './journal-row-table'
import type { AgentJournalEpochReason, JournalRow } from './journal-row-schema'

/** Writes the chat's status from the fold an epoch transaction is about to publish, and whether that
 *  load reads back corrupt. A throw fails the transaction. */
export type JournalEpochStateWriter = (
  db: Database.Database,
  state: JournalReducerState,
  corrupt: boolean
) => void

export function publishNewEpoch(input: {
  database: JournalHostDatabase
  identity: AgentSessionJournalIdentity
  epoch: string
  reason: AgentJournalEpochReason
  fence: number
  now: number
  writeState: JournalEpochStateWriter
  /** Called the instant the transaction commits, before any fallible follow-up. */
  onPublished: (loaded: JournalLoad) => void
}): void {
  const row: JournalRow = {
    kind: 'epoch',
    reason: input.reason,
    providerHandle: input.identity.providerHandle,
    // Carries no body: an older host must keep reading a turn-free session past row 1.
    v: journalRowSchemaVersion([]),
    epoch: input.epoch,
    seq: 1,
    fence: input.fence,
    ts: input.now
  }

  const { sessionId } = input.identity
  // Folded first, so the transaction stores the status of the epoch it publishes. A repair's epoch
  // reads back corrupt until the chat writes past it, as its replay would.
  const state = createJournalReducerState(sessionId, input.epoch)
  applyJournalRow(state, row)
  state.oldestSequence = 1
  const corrupt = input.reason === 'unreconcilable_prefix'
  input.database.transaction((db) => {
    const retired = readJournalSessionEpoch(db, sessionId)
    if (retired !== null) {
      deleteJournalEpochRows(db, sessionId, retired)
    }
    clearJournalRepairMarker(db, sessionId)
    insertJournalRow(db, sessionId, row)
    publishJournalSessionEpoch(db, input.identity, input.epoch)
    input.writeState(db, state, corrupt)
  })

  // COMMIT landed: on disk the superseded prefix is gone and this epoch is the
  // live one. The caller adopts that immediately, or a later failure leaves the
  // store writing into an epoch that no longer exists.
  input.onPublished({ state, readOnly: false, corrupt, malformedRows: 0 })
}
