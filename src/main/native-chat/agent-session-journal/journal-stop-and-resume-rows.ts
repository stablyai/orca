import { journalInputOrder } from './journal-input-order'
// Additive tombstone fields keep Stop/Resume/reopen marks compatible with older row-kind readers.

import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalReducerState } from './journal-reducer'
import { journalRowBase } from './journal-row-builders'
import type { JournalStopEvent, JournalTombstoneRow } from './journal-row-schema'
import { journalUserStopInForce } from './queued-message-pause'

// Reserve IDs that no real item uses.
const JOURNAL_STOP_EVENT_ITEM_ID = agentJournalItemKey({
  provider: 'orca',
  clientMessageId: 'stop-event'
})
const JOURNAL_QUEUE_RESUME_ITEM_ID = agentJournalItemKey({
  provider: 'orca',
  clientMessageId: 'queue-resume'
})
const JOURNAL_QUEUE_REOPEN_ITEM_ID = agentJournalItemKey({
  provider: 'orca',
  clientMessageId: 'queue-reopen'
})

type RowPlace = { state: JournalReducerState; seq: number; fence: number; ts: number }

export function buildJournalQueueClearRow(
  input: RowPlace & { clear: NonNullable<JournalTombstoneRow['queueClear']> }
): JournalTombstoneRow {
  return {
    kind: 'tombstone',
    itemId: agentJournalItemKey({ provider: 'orca', clientMessageId: 'queue-context-clear' }),
    revision: 1,
    queueClear: input.clear,
    ...journalRowBase(input.state.epoch, input.seq, input.fence, input.ts)
  }
}

export function buildJournalStopEventRow(
  input: RowPlace & { event: JournalStopEvent }
): JournalTombstoneRow {
  return {
    kind: 'tombstone',
    itemId: JOURNAL_STOP_EVENT_ITEM_ID,
    revision: 1,
    stopEvent: input.event,
    ...journalRowBase(input.state.epoch, input.seq, input.fence, input.ts)
  }
}

export function buildJournalQueueResumeRow(input: RowPlace): JournalTombstoneRow {
  return {
    kind: 'tombstone',
    itemId: JOURNAL_QUEUE_RESUME_ITEM_ID,
    revision: 1,
    queueResume: true,
    ...journalRowBase(input.state.epoch, input.seq, input.fence, input.ts)
  }
}

export function buildJournalQueueReopenRow(
  input: RowPlace & { since?: number }
): JournalTombstoneRow {
  return {
    kind: 'tombstone',
    itemId: JOURNAL_QUEUE_REOPEN_ITEM_ID,
    revision: 1,
    queueReopen: true,
    ...(input.since !== undefined ? { queueReopenSince: input.since } : {}),
    ...journalRowBase(input.state.epoch, input.seq, input.fence, input.ts)
  }
}

export function journalStopEventRowBuilder(
  state: () => JournalReducerState,
  event: Omit<JournalStopEvent, 'at'>,
  fence: number
): (seq: number, ts: number) => JournalTombstoneRow {
  const current = state()
  const input = journalInputOrder(current)
  const cut =
    event.reason === 'user-stop' && !(input.sendingSubmissions().length > 0)
      ? input.newestTurn.usageLimitCut.read()
      : undefined
  const index = current.derivedTurnScope.cancellations
  const targets = index.capture(fence, event.turnId).map((target) => ({ ...target }))
  const historical = cut && index.forItem(cut.turnItemId)
  if (
    event.turnId === undefined &&
    historical &&
    !targets.some((entry) => entry.executionId === historical.executionId)
  ) {
    targets.push({ ...historical })
  }
  return (seq, ts) =>
    buildJournalStopEventRow({
      state: state(),
      seq,
      fence,
      ts,
      event: { ...event, targets: event.targets ?? targets, at: ts }
    })
}

export function journalQueueResumeRowBuilder(
  state: () => JournalReducerState,
  fence: number
): (seq: number, ts: number) => JournalTombstoneRow {
  return (seq, ts) => buildJournalQueueResumeRow({ state: state(), seq, fence, ts })
}

/** The person's send lifts their Stop: its Resume mark commits with the send, so it never falls back. */
export function journalStopLiftRows(
  state: () => JournalReducerState,
  fence = state().highestFence
): ((seq: number, ts: number) => JournalTombstoneRow)[] {
  return journalUserStopInForce(state().queuePauseMarks)
    ? [journalQueueResumeRowBuilder(state, fence)]
    : []
}

export function journalQueueReopenRowBuilder(
  state: () => JournalReducerState,
  fence: number,
  since?: number
): (seq: number, ts: number) => JournalTombstoneRow {
  return (seq, ts) =>
    buildJournalQueueReopenRow({ state: state(), seq, fence, ts, ...(since ? { since } : {}) })
}
