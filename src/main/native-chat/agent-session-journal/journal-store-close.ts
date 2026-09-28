// Releasing the one SQLite connection a store holds for its lifetime.
//
// The contract, in five parts:
//
//  1. Closed-state admission happens at ENQUEUE, once, and is permanent. The
//     flag lives on the store's write gate; it is never cleared, not by a
//     rejection and not by a retry. A store that failed to close is still a
//     store nobody may write to.
//  2. The close step shares the write queue and BYPASSES that gate — a close
//     that consulted the flag it had just set would refuse itself. Same queue
//     orders the release behind admitted work; separate gate lets it run.
//  3. One in-flight attempt, shared: concurrent callers get the same outcome.
//  4. Fulfilled is TERMINAL; rejected is not. A later call after fulfilment is a
//     genuine no-op — `DatabaseSync.close()` throws `ERR_INVALID_STATE` on a
//     second call, so re-entering after success is the bug, not the fix.
//  5. The release is deliberately unguarded. There is no way to ask whether a
//     `db.close()` that threw released the handle first, and guarding the step
//     would skip it on retry — guaranteeing a permanent leak in exactly the case
//     where it did not release.

import { AgentSessionJournalError } from './journal-write-guards'
import type Database from '../../sqlite/sync-database'

/**
 * The write queue and its closed gate. Admission is checked at ENQUEUE and is
 * permanent; the close step reaches the same queue through `serializePastGate`,
 * because a close that consulted the flag it had just set would refuse itself.
 */
export class JournalWriteQueue {
  private writes: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(private readonly sessionId: string) {}

  markClosed(): void {
    this.closed = true
  }

  serialize<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new AgentSessionJournalError(
          'journal_closed',
          `agent-session journal for ${this.sessionId} is closed`
        )
      )
    }
    return this.serializePastGate(run)
  }

  serializePastGate<T>(run: () => Promise<T>): Promise<T> {
    const started = this.writes.then(run)
    this.writes = started.catch(() => undefined)
    return started
  }
}

export class JournalConnectionCloser {
  private released = false
  private inFlight: Promise<void> | null = null

  constructor(
    private readonly deps: {
      connection: () => Database.Database | null
      /** Chains onto the store's write queue past the closed gate. */
      enqueue: (run: () => Promise<void>) => Promise<void>
    }
  ) {}

  get isReleased(): boolean {
    return this.released
  }

  close(): Promise<void> {
    if (this.released) {
      return Promise.resolve()
    }
    if (this.inFlight) {
      return this.inFlight
    }
    const attempt = this.deps
      .enqueue(() => this.release())
      .then(
        () => {
          this.released = true
          this.inFlight = null
        },
        (error: unknown) => {
          this.inFlight = null
          throw error
        }
      )
    this.inFlight = attempt
    return attempt
  }

  private async release(): Promise<void> {
    const db = this.deps.connection()
    if (!db) {
      return
    }
    // SQLite checkpoints and removes the WAL itself when the last connection to
    // the database closes.
    db.close()
  }
}
