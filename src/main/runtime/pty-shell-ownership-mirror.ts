import { TerminalShellLifecycleScanner } from '../daemon/terminal-shell-lifecycle-scanner'
import type { TerminalOwner } from '../../shared/terminal-owner'

// Bound serialization latency independently of slow RPC/process inspection; late proof remains generation-fenced.
const SETTLE_DEADLINE_MS = 750

/** Observe emulator bytes without pausing or injecting; daemon hosts confirm stream ownership, direct local PTYs use fresh process inspection. */
export class PtyShellOwnershipMirror {
  private readonly scanner = new TerminalShellLifecycleScanner()
  private confirmInFlight = false
  private confirmAttempt = 0
  private latestCandidateGeneration: number | undefined
  private settleWaiters: (() => void)[] = []
  private disposed = false

  constructor(private readonly confirm: () => Promise<boolean>) {}

  scan(data: string): void {
    if (this.disposed) {
      return
    }
    let rest = data
    while (rest.length > 0) {
      const events = this.scanner.scan(rest)
      if (events.cleanExitCandidate) {
        this.startConfirmation(events.cleanExitCandidate.generation)
      }
      if (events.uncleanDeathTriggerEnd === undefined) {
        return
      }
      // The stream owner already resolved this boundary; ask it, keep scanning.
      this.startConfirmation(this.scanner.generation)
      rest = rest.slice(events.uncleanDeathTriggerEnd)
    }
  }

  /** Reset Terminal: the ground for this mirror's view of mode ownership, already scanned. */
  groundInputModes(): string {
    return this.scanner.groundProcessBoundary()
  }

  get owner(): TerminalOwner | undefined {
    return this.scanner.owner
  }

  /** Consume the marker hint: true at most once per clean prompt cycle. */
  claimIdlePrompt(): boolean {
    const idle = this.scanner.isIdleAtPrompt
    this.scanner.forgetIdlePrompt()
    return idle
  }

  seedOwner(owner: TerminalOwner | undefined, opts: { alternateScreen?: boolean } = {}): void {
    this.scanner.seedOwner(owner, opts)
  }

  /** Bound the current-generation proof wait; generation advance ends it and unsettled proof means no owner. */
  async settle(): Promise<void> {
    const target = this.scanner.generation
    let deadlineHit = false
    const deadline = setTimeout(() => {
      deadlineHit = true
      this.resolveSettleWaiters()
    }, SETTLE_DEADLINE_MS)
    deadline.unref?.()
    try {
      while (
        this.confirmInFlight &&
        this.scanner.generation <= target &&
        !this.disposed &&
        !deadlineHit
      ) {
        await new Promise<void>((resolve) => this.settleWaiters.push(resolve))
      }
    } finally {
      clearTimeout(deadline)
    }
  }

  dispose(): void {
    this.disposed = true
    this.resolveSettleWaiters()
  }

  private startConfirmation(generation: number): void {
    this.latestCandidateGeneration = generation
    if (this.confirmInFlight || this.disposed) {
      return
    }
    this.confirmInFlight = true
    const requested = generation
    const attempt = ++this.confirmAttempt
    // Retire hung confirmation so later candidates can retry during this PTY's lifetime.
    const deadline = setTimeout(
      () => this.retireConfirmAttempt(attempt, requested),
      SETTLE_DEADLINE_MS
    )
    deadline.unref?.()
    // An injected synchronous throw must not strand confirmInFlight.
    let proof: Promise<boolean>
    try {
      proof = this.confirm()
    } catch {
      proof = Promise.resolve(false)
    }
    void proof
      .then((confirmed) => {
        // Retired attempts cannot change ownership after fresh bytes or a new confirmation.
        if (attempt === this.confirmAttempt && confirmed && !this.disposed) {
          this.scanner.trySetOwner(requested)
        }
      })
      .catch(() => {})
      .finally(() => {
        clearTimeout(deadline)
        this.retireConfirmAttempt(attempt, requested)
      })
  }

  private retireConfirmAttempt(attempt: number, requested: number): void {
    if (attempt !== this.confirmAttempt) {
      return
    }
    this.confirmAttempt += 1
    this.confirmInFlight = false
    const latest = this.latestCandidateGeneration
    if (
      latest !== undefined &&
      latest !== requested &&
      latest === this.scanner.generation &&
      !this.disposed
    ) {
      // One superseding candidate can still be current; stale ones are not retried.
      this.startConfirmation(latest)
    }
    this.resolveSettleWaiters()
  }

  private resolveSettleWaiters(): void {
    const waiters = this.settleWaiters
    this.settleWaiters = []
    for (const waiter of waiters) {
      waiter()
    }
  }
}
