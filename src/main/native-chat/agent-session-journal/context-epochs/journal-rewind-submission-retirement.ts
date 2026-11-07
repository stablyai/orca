import { parseAgentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalReducerState } from '../projection/journal-reducer'

export function retireRewoundJournalSubmission(state: JournalReducerState, itemId: string): void {
  const identity = parseAgentJournalItemKey(itemId)
  if (identity?.provider !== 'orca') {
    return
  }
  for (const providerItemId of state.queries.aliasesForSubmission(state, itemId)) {
    state.aliases.delete(providerItemId)
  }
}
