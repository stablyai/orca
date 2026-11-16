// Registry loss (pre-v1.4.106 pairing-path bug) caused silent repeated 4001 refusals; signal once per runtime only after a burst, not stray probes.

const DEFAULT_FAILURE_THRESHOLD = 3
const DEFAULT_WINDOW_MS = 60_000

export type UnpairedDeviceAuthThrottleOptions = {
  onTrigger: () => void
  // Failures within windowMs needed before onTrigger fires (default 3 in 60s).
  failureThreshold?: number
  windowMs?: number
  now?: () => number
}

export class UnpairedDeviceAuthThrottle {
  private readonly onTrigger: () => void
  private readonly failureThreshold: number
  private readonly windowMs: number
  private readonly now: () => number
  private readonly failureTimestamps: number[] = []
  private triggered = false

  constructor(options: UnpairedDeviceAuthThrottleOptions) {
    this.onTrigger = options.onTrigger
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
    this.now = options.now ?? Date.now
  }

  recordFailure(): void {
    if (this.triggered) {
      return
    }
    const now = this.now()
    this.failureTimestamps.push(now)
    while (this.failureTimestamps.length > 0 && now - this.failureTimestamps[0]! > this.windowMs) {
      this.failureTimestamps.shift()
    }
    if (this.failureTimestamps.length >= this.failureThreshold) {
      this.triggered = true
      this.failureTimestamps.length = 0
      this.onTrigger()
    }
  }
}
