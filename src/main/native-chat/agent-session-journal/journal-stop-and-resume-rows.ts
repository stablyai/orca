import { releasedJournalMailBoundary } from './journal-mail-boundary'
// Additive tombstone fields keep Stop/Resume/reopen marks compatible with older row-kind readers.

import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { JournalReducerState } from './journal-reducer'
import { journalRowBase } from './journal-row-builders'
import type { JournalStopEvent, JournalTombstoneRow } from './journal-row-schema'

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
  return (seq, ts) =>
    buildJournalStopEventRow({ state: state(), seq, fence, ts, event: { ...event, at: ts } })
}

export function journalQueueResumeRowBuilder(
  state: () => JournalReducerState,
  fence: number
): (seq: number, ts: number) => JournalTombstoneRow {
  return (seq, ts) => {
    const current = state()
    return {
      ...buildJournalQueueResumeRow({ state: current, seq, fence, ts }),
      mailBoundary: releasedJournalMailBoundary(current.sessionId, current.epoch, seq)
    }
  }
}

export function journalQueueReopenRowBuilder(
  state: () => JournalReducerState,
  fence: number,
  since?: number
): (seq: number, ts: number) => JournalTombstoneRow {
  return (seq, ts) =>
    buildJournalQueueReopenRow({ state: state(), seq, fence, ts, ...(since ? { since } : {}) })
}
