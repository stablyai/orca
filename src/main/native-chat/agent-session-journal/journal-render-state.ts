import type { AgentJournalSnapshot } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { compareAgentJournalItems } from '../../../shared/agent-session/journal/agent-session-journal-position'
import { publicJournalItem } from './journal-execution-interruption'
import { isPublicJournalExecution } from './journal-execution-view'
import { projectJournalStopNote } from './journal-stop-note-projection'
import type { JournalReducerState } from './journal-reducer'

export function renderJournalState(state: JournalReducerState): AgentJournalSnapshot {
  // Map insertion order changes on recreation; journal position alone orders the timeline.
  const items = [...state.items.values()]
    .filter((item) => isPublicJournalExecution(state, item))
    .map((item) => projectJournalStopNote(publicJournalItem(item), state.items))
    .sort(compareAgentJournalItems)
  return {
    sessionId: state.sessionId,
    cursor: { epoch: state.epoch, sequence: state.lastSequence },
    items,
    submissions: [...state.submissions.values()].sort((a, b) => a.submittedAt - b.submittedAt)
  }
}
