// Opening a new epoch.
//
// One transaction: discard every row of the superseded epoch, insert the new
// epoch row at sequence 1 and the queue's cards still owed an answer, and move
// the session projection onto it. Superseded rows are DELETED rather than
// retained — nothing would ever shed them.

import { journalRowSchemaVersion } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalLoad } from './journal-open'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { buildJournalQueueRow } from './journal-queue-events'
import type { JournalQueueRestatement } from './journal-queued-messages'
import {
  deleteJournalEpochRows,
  insertJournalRow,
  publishJournalSessionEpoch,
  readJournalSessionEpoch
} from './journal-row-table'
import type { AgentJournalEpochReason, JournalRow } from './journal-row-schema'

export function publishNewEpoch(input: {
  database: JournalHostDatabase
  identity: AgentSessionJournalIdentity
  epoch: string
  reason: AgentJournalEpochReason
  fence: number
  now: number
  /** The cards restated in the new epoch; it carries no submission, so a card whose hand-off was
   *  not handed over yet waits again (`retainedQueueFacts`). */
  queue: JournalQueueRestatement
  /** Called the instant the transaction commits, before any fallible follow-up. */
  onPublished: (loaded: JournalLoad) => void
}): void {
  const row: JournalRow = {
    kind: 'epoch',
    reason: input.reason,
    providerHandle: agentSessionJournalProviderHandle(input.identity),
    // Carries no body: an older host must keep reading a turn-free session past row 1.
    v: journalRowSchemaVersion([]),
    epoch: input.epoch,
    seq: 1,
    fence: input.fence,
    ts: input.now
  }

  const { sessionId } = input.identity
  const state = createJournalReducerState(sessionId, input.epoch)
  applyJournalRow(state, row)
  const rows: JournalRow[] = [row]
  for (const { messageId, change } of input.queue.cards) {
    if (change) {
      const card = buildJournalQueueRow(state, messageId, change, state.lastSequence + 1, input.now)
      applyJournalRow(state, card)
      rows.push(card)
    }
  }
  input.database.transaction((db) => {
    const retired = readJournalSessionEpoch(db, sessionId)
    if (retired !== null) {
      deleteJournalEpochRows(db, sessionId, retired)
    }
    for (const each of rows) {
      insertJournalRow(db, sessionId, each)
    }
    input.queue.receipt.write(db)
    publishJournalSessionEpoch(db, input.identity, input.epoch)
  })

  // COMMIT landed: on disk the superseded prefix is gone and this epoch is the
  // live one. The caller adopts that immediately, or a later failure leaves the
  // store writing into an epoch that no longer exists.
  input.queue.receipt.committed()
  state.oldestSequence = 1
  input.onPublished({ state, newer: null, damage: null })
}
