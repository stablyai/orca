import { finishJournalSteps } from './journal-reconstruction-steps'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalReducerState } from './journal-reducer'

export function retireRewoundJournalSubmission(state: JournalReducerState, itemId: string): void {
  finishJournalSteps(retireRewoundJournalSubmissionSteps(state, itemId))
}
export function* retireRewoundJournalSubmissionSteps(
  state: JournalReducerState,
  itemId: string
): Generator<void> {
  const identity = parseAgentJournalItemKey(itemId)
  if (identity?.provider !== 'orca') {
    return
  }
  state.submissions.delete(identity.clientMessageId)
  state.receipts.delete(identity.clientMessageId)
  for (const [providerItemId, submissionItemId] of state.aliases) {
    if (submissionItemId === itemId) {
      state.aliases.delete(providerItemId)
    }
    yield
  }
}
