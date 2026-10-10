// The queue's automatic send meeting storage another connection holds (SQLITE_BUSY or locked): not
// the person's failure, so nothing is shown and the card is not held. The same send is retried
// after a backoff, in memory only, until it lands, the card moves on (a Send now, Delete or Stop)
// or the process ends; after a bounded run it falls back to the held card, so a person can act and
// nothing is owed forever. Any other failure holds the card at once, as before.

import { isTransientSqliteContention } from '../../sqlite/sqlite-read-failure'
import {
  RECONCILIATION_MAX_FAILED_ATTEMPTS,
  reconciliationBackoffDelay
} from './structured-agent-session-reconciliation-backoff'

/** Whether a failure, or one it wraps, is SQLite contention (`isTransientSqliteContention`). */
export function isTransientStorageFailure(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; current !== undefined && depth < 5; depth += 1) {
    if (isTransientSqliteContention(current)) {
      return true
    }
    current = current instanceof Error ? current.cause : undefined
  }
  return false
}

type PendingRetry = {
  messageId: string
  /** The conversation the failures were met on: a reopened chat's card starts fresh. */
  journal: object
  failures: number
  timer: ReturnType<typeof setTimeout> | null
}

export class StructuredAgentSessionQueuedDrainRetry {
  private readonly pending = new Map<string, PendingRetry>()

  /** `wake`: schedules the chat's drain, whose step re-derives everything. */
  constructor(private readonly wake: (sessionId: string) => void) {}

  /** Whether this card's send waits out a backoff: a step woken meanwhile leaves it to the timer. */
  waiting(sessionId: string, messageId: string, journal: object): boolean {
    const entry = this.pending.get(sessionId)
    return entry?.messageId === messageId && entry.journal === journal && entry.timer !== null
  }

  /** A transient failure of this card's send: true while it is retried later, false once the
   *  run is given up (the caller then holds the card). */
  retryLater(sessionId: string, messageId: string, journal: object): boolean {
    const previous = this.pending.get(sessionId)
    const failures =
      previous?.messageId === messageId && previous.journal === journal ? previous.failures + 1 : 1
    this.settled(sessionId)
    if (failures >= RECONCILIATION_MAX_FAILED_ATTEMPTS) {
      return false
    }
    const entry: PendingRetry = { messageId, journal, failures, timer: null }
    entry.timer = setTimeout(() => {
      entry.timer = null
      this.wake(sessionId)
    }, reconciliationBackoffDelay(failures))
    // A backoff alone never keeps the process alive.
    entry.timer.unref?.()
    this.pending.set(sessionId, entry)
    return true
  }

  /** The send landed, or the card moved on (sent, a person's Send now or Delete): its run ends. */
  settled(sessionId: string): void {
    const entry = this.pending.get(sessionId)
    if (entry?.timer) {
      clearTimeout(entry.timer)
    }
    this.pending.delete(sessionId)
  }

  dispose(): void {
    for (const sessionId of this.pending.keys()) {
      this.settled(sessionId)
    }
  }
}
