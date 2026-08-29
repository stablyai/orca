// Guards an append clears before it becomes durable.
//
// All four refuse loudly rather than degrade: a silent drop here is a message
// missing from the transcript with nothing to explain it.

import type { JournalPayloadLimits } from './journal-payload-bounds'
import { journalRowByteLength, type JournalRow } from './journal-row-schema'

export class AgentSessionJournalError extends Error {
  constructor(
    readonly code:
      | 'journal_read_only'
      | 'journal_stale_fence'
      | 'journal_bound_exceeded'
      | 'journal_rate_exceeded',
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

/** Total size and append rate for one session, bounding a runaway agent. */
export class JournalAppendBudget {
  private windowStart = 0
  private appendsInWindow = 0

  constructor(
    private readonly sessionId: string,
    private readonly limits: JournalPayloadLimits
  ) {}

  fork(): JournalAppendBudget {
    return new JournalAppendBudget(this.sessionId, this.limits)
  }

  get maxSessionBytes(): number {
    return this.limits.maxSessionBytes
  }

  wouldExceedSize(row: JournalRow, sizeBytes: number): boolean {
    return sizeBytes + journalRowByteLength(row) > this.limits.maxSessionBytes
  }

  assert(row: JournalRow, ts: number, sizeBytes: number): void {
    if (this.wouldExceedSize(row, sizeBytes)) {
      throw new AgentSessionJournalError(
        'journal_bound_exceeded',
        `agent-session journal for ${this.sessionId} reached its ${this.limits.maxSessionBytes}-byte bound`
      )
    }
    if (ts - this.windowStart >= this.limits.appendWindowMs) {
      this.windowStart = ts
      this.appendsInWindow = 0
    }
    this.appendsInWindow += 1
    if (this.appendsInWindow > this.limits.maxAppendsPerWindow) {
      throw new AgentSessionJournalError(
        'journal_rate_exceeded',
        `agent-session journal for ${this.sessionId} exceeded ${this.limits.maxAppendsPerWindow} appends per ${this.limits.appendWindowMs}ms`
      )
    }
  }
}
