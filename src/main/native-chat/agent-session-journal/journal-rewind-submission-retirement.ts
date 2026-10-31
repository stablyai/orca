import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { JournalReducerState } from './journal-reducer'

export function retireRewoundJournalSubmission(state: JournalReducerState, itemId: string): void {
  const identity = parseAgentJournalItemKey(itemId)
  if (identity?.provider !== 'orca') {
    return
  }
  for (const [providerItemId, submissionItemId] of state.aliases) {
    if (submissionItemId === itemId) {
      state.aliases.delete(providerItemId)
    }
  }
}
