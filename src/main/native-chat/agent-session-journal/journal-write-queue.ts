// Closing refuses new admission permanently; already-admitted writes still commit and drain.

import { AgentSessionJournalError } from './journal-write-guards'

/** Async bodies could interleave sequence assignment and commits. */
export type JournalWriteResult<T> = T extends PromiseLike<unknown> ? never : T
export type JournalWriteBody<T> = () => JournalWriteResult<T>

/** Idle writes commit synchronously; reentrant/waiting writes queue. Admission remains valid after close. */
export class JournalWriteQueue {
  /** Track settlement regardless of write success. */
  private writes: Promise<unknown> = Promise.resolve()
  private waiting = 0
  private running = false
  private closed = false

  constructor(private readonly sessionId: string) {}

  markClosed(): void {
    this.closed = true
  }

  serialize<T>(run: JournalWriteBody<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(this.closedError())
    }
    return this.lineBusy ? this.join(run) : this.runNow(run)
  }

  /** Read between preceding and later writes; closed queues refuse reads from potentially replaced folds. */
  readInOrder<T>(read: () => T): Promise<T> {
    if (this.closed) {
      return Promise.reject(this.closedError())
    }
    return this.lineBusy ? this.join(read) : this.runNow(read)
  }

  private get lineBusy(): boolean {
    return this.running || this.waiting > 0
  }

  private closedError(): AgentSessionJournalError {
    return new AgentSessionJournalError(
      'journal_closed',
      `agent-session journal for ${this.sessionId} is closed`
    )
  }

  drain(): Promise<void> {
    return this.writes.then(() => undefined)
  }

  private runNow<T>(run: () => T): Promise<T> {
    let release: (settled: Promise<unknown>) => void = () => undefined
    this.writes = new Promise<unknown>((resolve) => {
      release = resolve
    })
    this.running = true
    let result: Promise<T>
    try {
      result = Promise.resolve(run())
    } catch (error) {
      result = Promise.reject(error)
    } finally {
      this.running = false
    }
    release(result.catch(() => undefined))
    return result
  }

  private join<T>(run: () => T): Promise<T> {
    const started = this.writes.then(run)
    this.writes = started.catch(() => undefined)
    this.waiting++
    const settle = (): void => {
      this.waiting--
    }
    started.then(settle, settle)
    return started
  }
}
