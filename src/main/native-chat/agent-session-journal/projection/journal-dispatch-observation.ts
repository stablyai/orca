import type { JournalInputReader } from '../journal-input-reads'
import type { AgentJournalDispatchState } from '../../../../shared/agent-session/journal/agent-session-journal-types'

export type AgentJournalDispatchObservation = {
  state: AgentJournalDispatchState
  recovered: boolean
}

export async function latestJournalDispatchObservation(
  journal: { reads: { input: JournalInputReader } },
  fence: number
): Promise<AgentJournalDispatchObservation | null> {
  const { submission } = await journal.reads.input({ kind: 'latest-submission', fence })
  return submission
    ? { state: submission.dispatchState, recovered: submission.recovered === true }
    : null
}
