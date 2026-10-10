import type {
  AgentJournalDispatchState,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'

export type AgentJournalDispatchObservation = {
  state: AgentJournalDispatchState
  recovered: boolean
}

/** Returns the latest write-ahead submission for the execution fence. */
export function latestJournalDispatchObservation(
  journal: {
    submissions: () => readonly AgentJournalSubmission[]
  },
  fence: number
): AgentJournalDispatchObservation | null {
  const latest = journal
    .submissions()
    .reduce<AgentJournalSubmission | null>(
      (current, submission) =>
        submission.fence === fence &&
        (current === null || submission.submittedAt >= current.submittedAt)
          ? submission
          : current,
      null
    )
  return latest ? { state: latest.dispatchState, recovered: latest.recovered === true } : null
}
