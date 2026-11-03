// Closing refuses new admission permanently; already-admitted writes still commit and drain.

import { AgentSessionJournalError } from './journal-write-guards'

export type JournalWriteBody<T> = () => T | Promise<T>

/** Ownership lasts through adoption and settlement; admitted writes remain valid after close. */
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
  readInOrder<T>(read: JournalWriteBody<T>): Promise<T> {
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

  private runNow<T>(run: JournalWriteBody<T>): Promise<T> {
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
    }
    const settled = result.finally(() => {
      this.running = false
    })
    release(settled.catch(() => undefined))
    return settled
  }

  private join<T>(run: JournalWriteBody<T>): Promise<T> {
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
