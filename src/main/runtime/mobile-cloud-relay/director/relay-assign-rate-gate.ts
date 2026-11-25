// Enforce the director's 5s host limit below all retry/reconcile paths, which can otherwise retry immediately.
const ASSIGN_MIN_INTERVAL_MS = 5_000
const ASSIGN_INTERVAL_JITTER_MS = 500
// Slice waits to honor raised deadlines and supersession promptly.
const ASSIGN_WAIT_SLICE_MS = 1_000
// Fail long Retry-After waits inline; pairing IPC cannot park for minutes, but scheduled retry retains the deadline.
const ASSIGN_MAX_INLINE_WAIT_MS = 15_000

export class RelayAssignAbortedError extends Error {
  constructor() {
    super('relay_assignment_aborted_stale')
  }
}

export class RelayAssignRateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('relay_assignment_rate_limited_locally')
  }
}

export type RelayAssignRateGateOptions = {
  now?: () => number
  // Test sleeps must advance now or the clock-rereading loop never terminates.
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

export function relayAssignRateKey(directorUrl: string, relayHostId: string): string {
  return `${directorUrl} ${relayHostId}`
}

export class RelayAssignRateGate {
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number
  private readonly nextPermittedAt = new Map<string, number>()
  private readonly tails = new Map<string, Promise<void>>()

  constructor(options: RelayAssignRateGateOptions = {}) {
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    this.random = options.random ?? Math.random
  }

  get trackedKeyCount(): number {
    return this.nextPermittedAt.size
  }

  async reserve(key: string, isCurrent?: () => boolean): Promise<void> {
    const prior = this.tails.get(key)
    let release = (): void => {}
    const link = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = prior ? prior.then(() => link) : link
    this.tails.set(key, tail)
    let stale = false
    try {
      await prior
      // Recheck sibling Retry-After and caller currency each slice; stale callers cannot spend slots.
      for (;;) {
        stale = isCurrent ? !isCurrent() : false
        if (stale) {
          break
        }
        const waitMs = (this.nextPermittedAt.get(key) ?? 0) - this.now()
        if (waitMs <= 0) {
          break
        }
        if (waitMs > ASSIGN_MAX_INLINE_WAIT_MS) {
          this.pruneExpired()
          throw new RelayAssignRateLimitedError(waitMs)
        }
        await this.sleep(Math.min(waitMs, ASSIGN_WAIT_SLICE_MS))
      }
      if (!stale) {
        this.book(key)
      }
      this.pruneExpired()
    } finally {
      release()
      if (this.tails.get(key) === tail) {
        this.tails.delete(key)
      }
    }
    if (stale) {
      throw new RelayAssignAbortedError()
    }
  }

  noteRetryAfter(key: string, retryAfterMs: number): void {
    if (retryAfterMs <= 0) {
      return
    }
    const until = this.now() + retryAfterMs
    if (until > (this.nextPermittedAt.get(key) ?? 0)) {
      this.nextPermittedAt.set(key, until)
    }
  }

  private book(key: string): void {
    const until =
      this.now() + ASSIGN_MIN_INTERVAL_MS + Math.floor(this.random() * ASSIGN_INTERVAL_JITTER_MS)
    if (until > (this.nextPermittedAt.get(key) ?? 0)) {
      this.nextPermittedAt.set(key, until)
    }
  }

  private pruneExpired(): void {
    const now = this.now()
    for (const [key, until] of this.nextPermittedAt) {
      if (until <= now) {
        this.nextPermittedAt.delete(key)
      }
    }
  }
}

// Every assign path shares this per-host booking interval.
export const sharedRelayAssignRateGate = new RelayAssignRateGate()
