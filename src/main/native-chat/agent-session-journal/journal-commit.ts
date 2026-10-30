import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import { applyJournalRow, type JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'

export function commitJournalRows(
  state: JournalReducerState,
  rows: readonly JournalRow[],
  savedAt: number,
  reopenFloor: AgentJournalCursor | null
): AgentJournalCursor | null {
  for (const row of rows) {
    applyJournalRow(state, row, savedAt)
  }
  return reopenFloor?.epoch === state.epoch &&
    state.queuePauseMarks.reopenedSequence >= reopenFloor.sequence
    ? null
    : reopenFloor
}
