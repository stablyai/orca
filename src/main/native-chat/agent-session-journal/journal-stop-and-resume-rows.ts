// The rows a Stop's event and a person's Resume append: tombstones of ids no item ever takes,
// each carrying its record as an extra key (`journal-row-schema.ts` says why not a row kind).

import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { JournalReducerState } from './journal-reducer'
import { journalRowBase } from './journal-row-builders'
import type { JournalStopEvent, JournalTombstoneRow } from './journal-row-schema'

/** One id per mark kind; no item ever takes either. */
const JOURNAL_STOP_EVENT_ITEM_ID = agentJournalItemKey({
  provider: 'orca',
  clientMessageId: 'stop-event'
})
const JOURNAL_QUEUE_RESUME_ITEM_ID = agentJournalItemKey({
  provider: 'orca',
  clientMessageId: 'queue-resume'
})

type RowPlace = { state: JournalReducerState; seq: number; fence: number; ts: number }

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

/** A Stop taking effect now: its event's time is its row's. */
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
  return (seq, ts) => buildJournalQueueResumeRow({ state: state(), seq, fence, ts })
}
