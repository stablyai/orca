// One chat's write queue: build, commit and adopt run one at a time, in arrival order.
//
// Closing is admission only. A closed store refuses new writes forever, so a stale reference
// (an event sink, a late callback) can never append from a fold a newer open has replaced; the
// writes already admitted still land, and `drain` resolves once they have.

import { AgentSessionJournalError } from './journal-write-guards'

/** What a write body returns: never a promise, since an await inside one would let a later write
 *  land first. */
export type JournalWriteResult<T> = T extends PromiseLike<unknown> ? never : T
export type JournalWriteBody<T> = () => JournalWriteResult<T>

/**
 * A write has landed in the fold when its call returns, unless it was issued from inside another
 * write or behind one still waiting in line.
 *
 * A write finds the queue idle unless a write is running or writes wait in line; then it runs
 * before `serialize` returns. Every write body is synchronous (`JournalWriteBody` refuses a
 * promise), so it has committed by then. Otherwise it joins the line behind the writes ahead of
 * it, never nested inside the running one. Admission is checked at ENQUEUE and is permanent.
 */
export class JournalWriteQueue {
  /** Settles once every write admitted so far has, whatever its outcome. */
  private writes: Promise<unknown> = Promise.resolve()
  /** Writes that joined the line and have not settled. */
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

  /** Runs `read` after every write admitted before it, whatever each one's outcome, and ahead of any
   *  admitted after: at once when none waits. A closed queue refuses it, as it refuses a write: its
   *  fold may be replaced. */
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

  /** Resolves once every write admitted so far has settled, whatever its outcome. */
  drain(): Promise<void> {
    return this.writes.then(() => undefined)
  }

  /** Runs before returning; a write issued from inside it joins the line behind it. */
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
