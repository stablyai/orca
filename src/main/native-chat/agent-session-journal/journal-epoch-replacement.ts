// Republishing a live item set into a fresh epoch.
//
// One transaction: discard the old epoch's rows, insert the epoch row plus the
// replacement items, and move the session projection.

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalProducerLinkage,
  AgentJournalTurnScope,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalLoad } from './journal-open'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { buildJournalItemRow, journalRowBase } from './journal-row-builders'
import {
  buildJournalQueueReopenRow,
  buildJournalQueueResumeRow,
  buildJournalStopEventRow
} from './journal-stop-and-resume-rows'
import type { JournalQueuePauseRestatement } from './queued-message-pause'
import {
  deleteJournalEpochRows,
  insertJournalRow,
  publishJournalSessionEpoch,
  readJournalSessionEpoch
} from './journal-row-table'
import type { AgentJournalEpochReason, JournalRow } from './journal-row-schema'
import { assertJournalFence } from './journal-write-guards'

export type JournalReplacementItem = AgentJournalProducerLinkage & {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  observedAt?: number
  /** Absent for history rebuilt from a source that never stated one: derived from position, as
   *  a legacy row's is, and then written down. */
  turnScope?: AgentJournalTurnScope
}

export function replaceJournalEpoch(input: {
  database: JournalHostDatabase
  identity: AgentSessionJournalIdentity
  reason: AgentJournalEpochReason
  fence: number
  items: readonly JournalReplacementItem[]
  /** Restated in the new epoch, or the rewind would release cards the person stopped, or bring
   *  back a /clear pause they already lifted. */
  queuePause: JournalQueuePauseRestatement
  now: () => number
  mintEpoch: () => string
  /** Called the instant the transaction commits, before any fallible follow-up. */
  onPublished: (loaded: JournalLoad) => void
}): void {
  const epoch = input.mintEpoch()
  const state = createJournalReducerState(input.identity.sessionId, epoch)
  const epochRow: JournalRow = {
    kind: 'epoch',
    reason: input.reason,
    providerHandle: agentSessionJournalProviderHandle(input.identity),
    ...journalRowBase(epoch, 1, input.fence, input.now())
  }
  const rows: JournalRow[] = [epochRow]
  applyJournalRow(state, epochRow)
  for (const item of input.items) {
    const row = buildJournalItemRow({
      state,
      identity: item.identity,
      body: item.body,
      seq: state.lastSequence + 1,
      fence: input.fence,
      ts: item.observedAt ?? input.now(),
      linkage: item,
      turnScope: item.turnScope ?? state.derivedTurnScope.scopeFor(item.body)
    })
    assertJournalFence(row.fence, state.highestFence)
    applyJournalRow(state, row)
    rows.push(row)
  }
  const { lifted, liveStop, reopened } = input.queuePause
  const place = () => ({ state, seq: state.lastSequence + 1, fence: input.fence, ts: input.now() })
  if (lifted) {
    const row = buildJournalQueueResumeRow(place())
    applyJournalRow(state, row)
    rows.push(row)
  }
  if (liveStop) {
    const row = buildJournalStopEventRow({ ...place(), event: liveStop })
    applyJournalRow(state, row)
    rows.push(row)
  }
  if (reopened) {
    const row = buildJournalQueueReopenRow(place())
    applyJournalRow(state, row)
    rows.push(row)
  }

  const { sessionId } = input.identity
  input.database.transaction((db) => {
    const retired = readJournalSessionEpoch(db, sessionId)
    if (retired !== null) {
      deleteJournalEpochRows(db, sessionId, retired)
    }
    for (const row of rows) {
      insertJournalRow(db, sessionId, row)
    }
    publishJournalSessionEpoch(db, input.identity, epoch)
  })

  // COMMIT landed: on disk the superseded rows are gone and this epoch is the
  // live one. The caller adopts that immediately, or a later failure leaves the
  // live store writing into an epoch whose rows were just deleted.
  state.oldestSequence = 1
  input.onPublished({ state, newer: null, damage: null })
}
