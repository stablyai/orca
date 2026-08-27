// Why: the director rate-limits /v1/assign per host at 5s, but every desktop
// retry path (coordinator full-jitter, drain full-jitter, reconcile() cancelling
// the Retry-After timer) can fire immediately, so hosts sit permanently limited.
// The gate lives below all of them, at the single call site that issues assigns.
const ASSIGN_MIN_INTERVAL_MS = 5_000
const ASSIGN_INTERVAL_JITTER_MS = 500
// Sleep in slices so a raise landing mid-wait is honored and a superseded
// caller aborts promptly instead of holding its IPC path for the full wait.
const ASSIGN_WAIT_SLICE_MS = 1_000
// Beyond this, fail fast with the remaining wait instead of parking the caller
// (pairing IPC awaits reconcile inline): a Retry-After can legitimately reach
// minutes, and the gate keeps the deadline for the scheduled retry.
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
  // Test fakes MUST advance `now` when sleeping — the wait loop re-reads the
  // clock each slice, so a no-op sleep against a frozen clock never terminates.
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
  // Per-key promise chain: concurrent callers queue behind each other's booking
  // instead of stampeding out of one shared sleep.
  private readonly tails = new Map<string, Promise<void>>()

  constructor(options: RelayAssignRateGateOptions = {}) {
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    this.random = options.random ?? Math.random
  }

  get trackedKeyCount(): number {
    return this.nextPermittedAt.size
  }

  // Waits out the remaining interval for this host, then books the next slot.
  // Resolves only when the caller may send; throws if isCurrent went false while waiting.
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
      // Re-read the deadline every slice: a sibling's Retry-After can raise it
      // mid-wait, and a caller superseded mid-wait must not spend the slot.
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

  // Retry-After outlives the coordinator's armed timer, which reconcile() cancels.
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

// Shared so every assign path — coordinator, drain recovery, any reconcile()
// bypass — books against the same per-host interval.
export const sharedRelayAssignRateGate = new RelayAssignRateGate()
