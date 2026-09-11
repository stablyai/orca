import type { TerminalShellLifecycleScanner } from './terminal-shell-lifecycle-scanner'

/**
 * Async ownership proof for clean alternate-screen exits: no pause, no
 * injection — a confirmed proof only marks the scanner's owner, guarded by the
 * generation captured at the candidate. Every attempt retires at the deadline
 * so a proof that never settles cannot wedge later candidates, and a retired
 * attempt's late verdict is inert.
 */
export class TerminalShellCleanExitConfirmation {
  private inFlightState = false
  private attempt = 0
  private waiters: (() => void)[] = []
  private latestCandidateGeneration: number | undefined

  constructor(
    private readonly opts: {
      scanner: TerminalShellLifecycleScanner
      confirmShellForeground: () => Promise<boolean>
      deadlineMs: () => number
      isDisposed: () => boolean
      isAlive: () => boolean
    }
  ) {}

  get inFlight(): boolean {
    return this.inFlightState
  }

  waitSettled(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  drainWaiters(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) {
      waiter()
    }
  }

  start(generation: number): void {
    this.latestCandidateGeneration = generation
    if (this.inFlightState || this.opts.isDisposed()) {
      return
    }
    this.inFlightState = true
    const requested = generation
    const attempt = ++this.attempt
    // Why the deadline: a proof that never settles must not wedge the in-flight
    // flag for the session's life, silently ignoring every later candidate.
    const deadline = setTimeout(() => this.retire(attempt, requested), this.opts.deadlineMs())
    deadline.unref?.()
    // Why the guard: the callback is injected; a synchronous throw must not
    // strand the in-flight flag.
    let proof: Promise<boolean>
    try {
      proof = this.opts.confirmShellForeground()
    } catch {
      proof = Promise.resolve(false)
    }
    void proof
      .then((confirmed) => {
        // A retired attempt's late verdict is inert: an unsettled proof already
        // read as no owner, and flipping it afterwards would race fresh bytes.
        if (
          attempt === this.attempt &&
          confirmed &&
          !this.opts.isDisposed() &&
          this.opts.isAlive()
        ) {
          this.opts.scanner.trySetOwner(requested)
        }
      })
      .catch(() => {})
      .finally(() => {
        clearTimeout(deadline)
        this.retire(attempt, requested)
      })
  }

  private retire(attempt: number, requested: number): void {
    if (attempt !== this.attempt) {
      return
    }
    this.attempt += 1
    this.inFlightState = false
    const latest = this.latestCandidateGeneration
    if (
      latest !== undefined &&
      latest !== requested &&
      latest === this.opts.scanner.generation &&
      !this.opts.isDisposed()
    ) {
      // One superseding candidate can still be current; stale ones are not retried.
      this.start(latest)
    }
    this.drainWaiters()
  }
}
