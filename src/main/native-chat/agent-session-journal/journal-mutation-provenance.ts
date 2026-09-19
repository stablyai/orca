import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'

export function recordJournalMutationProvenance(state: JournalReducerState, row: JournalRow): void {
  const itemIds =
    row.kind === 'item' || row.kind === 'tombstone'
      ? [row.itemId]
      : row.kind === 'lifecycle-batch'
        ? row.mutations.map((entry) => entry.itemId)
        : []
  for (const id of itemIds) {
    state.itemMutationSequences.set(state.aliases.get(id) ?? id, row.seq)
  }
  if (row.kind === 'submission' || row.kind === 'dispatch') {
    state.submissionMutationSequences.set(row.clientMessageId, row.seq)
  }
}
