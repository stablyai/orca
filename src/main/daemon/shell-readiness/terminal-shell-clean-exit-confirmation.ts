import type { TerminalShellLifecycleScanner } from './terminal-shell-lifecycle-scanner'

/** Confirm clean-exit ownership without pausing output; deadline retirement makes late verdicts inert. */
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
    // Retire stalled proofs so later exit candidates can still be checked.
    const deadline = setTimeout(() => this.retire(attempt, requested), this.opts.deadlineMs())
    deadline.unref?.()
    // Injected callbacks may throw synchronously; still retire the attempt.
    let proof: Promise<boolean>
    try {
      proof = this.opts.confirmShellForeground()
    } catch {
      proof = Promise.resolve(false)
    }
    void proof
      .then((confirmed) => {
        // Ignore retired verdicts so stale process evidence cannot race newer output.
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
