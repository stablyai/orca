// Back off resume closes and silent NAT rebinds to avoid connected/disconnected churn.
const RELAY_BACKOFF_MIN_MS = 250
const RELAY_BACKOFF_BASE_MS = 500
const RELAY_BACKOFF_CEILING_MS = 30_000
export const RELAY_STABLE_CONNECTION_MS = RELAY_BACKOFF_CEILING_MS
const RELAY_HOST_OFFLINE_RETRY_MIN_MS = 5_000
const RELAY_HOST_OFFLINE_RETRY_MAX_MS = 15_000
// Allow one jittered attach-timeout redial because the desktop’s control is seated; avoid synchronizing phones after a cell-wide event.
const RELAY_ATTACH_TIMEOUT_REDIAL_MIN_MS = 1_000
const RELAY_ATTACH_TIMEOUT_REDIAL_MAX_MS = 2_000
// Keep slow reprobes under gates so relay-only phones can recover; escalate/jitter to bound revoked-device traffic and fleet synchronization.
const RELAY_GATE_REPROBE_BASE_MS = 60_000
const RELAY_GATE_REPROBE_CEILING_MS = 15 * 60_000
// Cap director pacing so one header cannot park recovery indefinitely.
export const MOBILE_RELAY_RETRY_AFTER_MAX_MS = 120_000

export class RelayRetryDelays {
  constructor(private readonly randomBytes: (length: number) => Uint8Array) {}

  // Retry-After may increase delay, never accelerate dialing.
  transportDelayMs(consecutiveFailures: number, floorMs = 0): number {
    const exponent = Math.max(0, consecutiveFailures - 1)
    const cap = Math.min(RELAY_BACKOFF_CEILING_MS, RELAY_BACKOFF_BASE_MS * 2 ** exponent)
    // Full jitter (uniform in [0, cap)), floored so retries never busy-loop.
    return Math.max(RELAY_BACKOFF_MIN_MS, floorMs, Math.floor(cap * this.jitterFraction()))
  }

  hostOfflineDelayMs(attachTimeoutRedial = false): number {
    const [min, max] = attachTimeoutRedial
      ? [RELAY_ATTACH_TIMEOUT_REDIAL_MIN_MS, RELAY_ATTACH_TIMEOUT_REDIAL_MAX_MS]
      : [RELAY_HOST_OFFLINE_RETRY_MIN_MS, RELAY_HOST_OFFLINE_RETRY_MAX_MS]
    return min + Math.floor((max - min) * this.jitterFraction())
  }

  gateReprobeDelayMs(streak: number): number {
    const base = Math.min(
      RELAY_GATE_REPROBE_CEILING_MS,
      RELAY_GATE_REPROBE_BASE_MS * 2 ** Math.min(streak, 8)
    )
    return Math.floor(base * (0.75 + 0.5 * this.jitterFraction()))
  }

  private jitterFraction(): number {
    const [high, low] = this.randomBytes(2)
    return (((high ?? 0) << 8) | (low ?? 0)) / 0x1_00_00
  }
}
