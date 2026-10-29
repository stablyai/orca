// Refuse invalid appends loudly; silent drops would leave unexplained transcript gaps.

export class AgentSessionJournalError extends Error {
  constructor(
    readonly code:
      | 'journal_read_only'
      | 'journal_stale_fence'
      | 'journal_closed'
      | 'journal_submission_exists'
      | 'journal_row_rejected',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'AgentSessionJournalError'
  }
}

export function assertJournalWritable(readOnly: boolean, sessionId: string): void {
  if (readOnly) {
    throw new AgentSessionJournalError(
      'journal_read_only',
      `agent-session journal for ${sessionId} uses a newer schema; this host is read-only`
    )
  }
}

/** Reject superseded writers so owners cannot share a sequence space. */
export function assertJournalFence(fence: number, highestFence: number): void {
  if (fence < highestFence) {
    throw new AgentSessionJournalError(
      'journal_stale_fence',
      `fence ${fence} is behind the journal's ${highestFence}`
    )
  }
}

/** Reusing a submission ID would reset settled state and deliver twice. */
export function assertSubmissionIdUnused(
  submissions: ReadonlyMap<string, unknown>,
  clientMessageId: string
): void {
  if (submissions.has(clientMessageId)) {
    throw new AgentSessionJournalError(
      'journal_submission_exists',
      `a submission ${clientMessageId} is already recorded`
    )
  }
}
