// Guards an append clears before it becomes durable.
//
// Both refuse loudly rather than degrade: a silent drop here is a message
// missing from the transcript with nothing to explain it.

export class AgentSessionJournalError extends Error {
  constructor(
    readonly code: 'journal_read_only' | 'journal_stale_fence' | 'journal_closed',
    message: string
  ) {
    super(message)
    this.name = 'AgentSessionJournalError'
  }
}

/** A journal written by a newer schema is readable but never writable: this
 *  host cannot represent rows it does not understand. */
export function assertJournalWritable(readOnly: boolean, sessionId: string): void {
  if (readOnly) {
    throw new AgentSessionJournalError(
      'journal_read_only',
      `agent-session journal for ${sessionId} uses a newer schema; this host is read-only`
    )
  }
}

/** A write from a superseded owner is rejected outright — merging it would let
 *  two writers share one sequence space. */
export function assertJournalFence(fence: number, highestFence: number): void {
  if (fence < highestFence) {
    throw new AgentSessionJournalError(
      'journal_stale_fence',
      `fence ${fence} is behind the journal's ${highestFence}`
    )
  }
}
