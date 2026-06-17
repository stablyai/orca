/** Per-key sliding-window rate limiter for the webhook receiver. Bounds how
 *  often a single remote host can trigger (potentially expensive) automation
 *  runs — important once the listener is bound to a LAN/0.0.0.0 interface. */
export class WebhookRateLimiter {
  private readonly windowMs: number
  private readonly maxRequests: number
  private readonly hits = new Map<string, number[]>()

  constructor(opts: { windowMs?: number; maxRequests?: number } = {}) {
    this.windowMs = opts.windowMs ?? 60_000
    this.maxRequests = opts.maxRequests ?? 30
  }

  /** Record a request for `key` and report whether it is within the limit.
   *  `now` is injectable for deterministic tests. */
  tryAcquire(key: string, now: number = Date.now()): boolean {
    const windowStart = now - this.windowMs
    const recent = (this.hits.get(key) ?? []).filter((timestamp) => timestamp > windowStart)
    if (recent.length >= this.maxRequests) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(now)
    this.hits.set(key, recent)
    return true
  }

  /** Drop tracking for keys with no hits inside the current window. Called
   *  opportunistically so the map cannot grow unbounded across many sources. */
  prune(now: number = Date.now()): void {
    const windowStart = now - this.windowMs
    for (const [key, timestamps] of this.hits) {
      const recent = timestamps.filter((timestamp) => timestamp > windowStart)
      if (recent.length === 0) {
        this.hits.delete(key)
      } else {
        this.hits.set(key, recent)
      }
    }
  }

  reset(): void {
    this.hits.clear()
  }
}
