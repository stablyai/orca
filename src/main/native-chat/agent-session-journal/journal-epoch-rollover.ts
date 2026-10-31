// Delete and replace epochs atomically; retaining superseded rows would grow history without bound.

import { journalOutcomeSource } from './journal-outcome-format'
import { publishJournalOutcomeEpoch } from './journal-outcome-write'
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
  publishJournalSessionEpoch,
  readJournalSessionEpoch
} from './journal-row-table'
import type { AgentJournalEpochReason, JournalRow } from './journal-row-schema'
import { AgentSessionJournalError } from './journal-write-guards'

export function publishNewEpoch(input: {
  database: JournalHostDatabase
  identity: AgentSessionJournalIdentity
  epoch: string
  reason: AgentJournalEpochReason
  fence: number
  now: number
  /** Unhanded cards wait again; replacement submissions may relink them. */
  queue: JournalQueueRestatement
  /** The epoch the caller built from (null: none yet); a different stored epoch refuses. */
  expectedEpoch?: string | null
  /** Adopt committed state before fallible follow-up work. */
  onPublished: (loaded: JournalLoad) => void
}): void {
  const row: JournalRow = {
    kind: 'epoch',
    reason: input.reason,
    providerHandle: agentSessionJournalProviderHandle(input.identity),
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
  state.oldestSequence = 1
  input.database.transaction(
    (db) => {
      const retired = readJournalSessionEpoch(db, sessionId)
      if (input.expectedEpoch !== undefined && retired !== input.expectedEpoch) {
        throw new AgentSessionJournalError('journal_row_rejected', 'the chat epoch changed')
      }
      if (retired !== null) {
        journalOutcomeSource(db, sessionId, retired)
      }
      if (retired !== null) {
        deleteJournalEpochRows(db, sessionId, retired)
      }
      input.queue.receipt.write(db)
      publishJournalSessionEpoch(db, input.identity, input.epoch)
      return publishJournalOutcomeEpoch(db, sessionId, state.epoch, rows)
    },
    false,
    (publication) => {
      // Adopt, then finish the nonthrowing queue bookkeeping, before the fallible publication.
      const state = publication.adopt()
      input.queue.receipt.committed()
      input.onPublished({ state, newer: null, damage: null })
    }
  )
}
