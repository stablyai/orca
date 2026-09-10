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

/** A latched journal is readable but never writable. Two things latch one: rows
 *  from a newer schema this host cannot represent, and a repair that could not
 *  put the rows it must drop somewhere durable first. The message names neither,
 *  because the guard is not told which — `journalStoreLoadedFields` and the
 *  repair path both set the same flag. */
export function assertJournalWritable(readOnly: boolean, sessionId: string): void {
  if (readOnly) {
    throw new AgentSessionJournalError(
      'journal_read_only',
      `agent-session journal for ${sessionId} is latched read-only`
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
