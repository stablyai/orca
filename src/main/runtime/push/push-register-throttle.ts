// Why: notifications.registerPush costs a gateway write and a synchronous
// registry write on the main thread, and a paired phone may call it as often
// as it likes. A phone legitimately registers on switch-on, on each host
// connect, and on a token change, so a small per-device bucket bounds a loop
// without getting in the way of any of those.
const DEFAULT_CAPACITY = 10
const DEFAULT_WINDOW_MS = 60_000

type Bucket = { tokens: number; updatedAt: number }

export type PushRegisterThrottleOptions = {
  capacity?: number
  windowMs?: number
  now?: () => number
}

export class PushRegisterThrottle {
  private readonly buckets = new Map<string, Bucket>()
  private readonly capacity: number
  private readonly windowMs: number
  private readonly now: () => number

  constructor(options: PushRegisterThrottleOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
    this.now = options.now ?? Date.now
  }

  allow(deviceId: string): boolean {
    const now = this.now()
    const bucket = this.buckets.get(deviceId)
    const refilled = bucket
      ? Math.min(
          this.capacity,
          bucket.tokens + Math.max(0, ((now - bucket.updatedAt) * this.capacity) / this.windowMs)
        )
      : this.capacity
    if (refilled < 1) {
      this.buckets.set(deviceId, { tokens: refilled, updatedAt: now })
      return false
    }
    this.buckets.set(deviceId, { tokens: refilled - 1, updatedAt: now })
    return true
  }
}
