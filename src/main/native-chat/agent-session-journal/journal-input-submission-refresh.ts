import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'

export function refreshJournalInputSubmissions(
  state: JournalReducerState,
  row: JournalRow,
  refreshId: (id: string) => void
): void {
  const refreshItem = (itemId: string): void => {
    const identity = parseAgentJournalItemKey(itemId)
    if (identity?.provider === 'orca') {
      refreshId(identity.clientMessageId)
    }
  }
  if (row.kind === 'submission' || row.kind === 'dispatch') {
    refreshId(row.clientMessageId)
  } else if (row.kind === 'tombstone' && row.retireSubmission) {
    refreshItem(row.itemId)
  } else if (row.kind === 'item') {
    refreshItem(state.aliases.get(row.itemId) ?? row.itemId)
  } else if (row.kind === 'lifecycle-batch') {
    for (const mutation of row.mutations) {
      refreshItem(state.aliases.get(mutation.itemId) ?? mutation.itemId)
    }
  } else if (row.kind === 'queue') {
    const id = state.queue.cards.get(row.messageId)?.consumedAs
    if (id) {
      refreshId(id)
    }
  }
}
