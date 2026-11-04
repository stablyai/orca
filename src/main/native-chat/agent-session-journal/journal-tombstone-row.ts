import type { JournalReducerState } from './journal-reducer'
import type { JournalTombstoneRow } from './journal-row-schema'
import { nextJournalItemRevision } from './journal-item-revision'
import { journalRowBase } from './journal-row-builders'

export function journalTombstoneRowBuilder(
  state: () => JournalReducerState,
  itemId: string,
  fence: number,
  revisions?: Map<string, number>
): (seq: number, ts: number) => JournalTombstoneRow {
  return (seq, ts) =>
    buildJournalTombstoneRow({ state: state(), itemId, seq, fence, ts, revisions })
}

export function buildJournalTombstoneRow(input: {
  state: JournalReducerState
  itemId: string
  seq: number
  fence: number
  ts: number
  revisions?: Map<string, number>
}): JournalTombstoneRow {
  const itemId = input.state.aliases.get(input.itemId) ?? input.itemId
  return {
    kind: 'tombstone',
    itemId,
    // Rank above both live and tombstone revisions even if map-disjointness is later relaxed.
    revision: nextJournalItemRevision(input.state, itemId, input.revisions),
    ...journalRowBase(input.state.epoch, input.seq, input.fence, input.ts)
  }
}
