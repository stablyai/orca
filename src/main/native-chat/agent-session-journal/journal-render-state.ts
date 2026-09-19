import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'

/** Project the folded state into the client-facing snapshot. */
export function renderJournalState(state: JournalReducerState): AgentJournalSnapshot {
  // Sequence is the sole ordering key; map insertion order is not, because a
  // re-created item re-enters the map after the items that followed it.
  const items = [...state.items.values()].sort((a, b) => a.sequence - b.sequence)
  return {
    sessionId: state.sessionId,
    cursor: { epoch: state.epoch, sequence: state.lastSequence },
    items,
    submissions: [...state.submissions.values()].sort((a, b) => a.submittedAt - b.submittedAt)
  }
}
