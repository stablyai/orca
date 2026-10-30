// Delete and replace epochs atomically; retaining superseded rows would grow history without bound.

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
  /** Unhanded cards wait again; replacement submissions may relink them. */
  queue: JournalQueueRestatement
  /** Adopt committed state before fallible follow-up work. */
  onPublished: (loaded: JournalLoad) => void
}): void {
  const row: JournalRow = {
    kind: 'epoch',
    reason: input.reason,
    providerHandle: agentSessionJournalProviderHandle(input.identity),
    // Body-free epoch rows must remain readable by older hosts.
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

  // Adopt committed state before fallible work can leave writers targeting the deleted epoch.
  input.queue.receipt.committed()
  state.oldestSequence = 1
  input.onPublished({ state, newer: null, damage: null })
}
