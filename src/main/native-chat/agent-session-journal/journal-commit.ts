import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'

export function retireCoveredJournalFloor(
  state: JournalReducerState,
  reopenFloor: AgentJournalCursor | null
): AgentJournalCursor | null {
  return reopenFloor?.epoch === state.epoch &&
    state.queuePauseMarks.reopenedSequence >= reopenFloor.sequence
    ? null
    : reopenFloor
}
