// Why: relay resume closes and silent cellular NAT rebinds otherwise cause
// immediate re-dials that ping-pong the phone between connected and disconnected.
const RELAY_BACKOFF_MIN_MS = 250
const RELAY_BACKOFF_BASE_MS = 500
const RELAY_BACKOFF_CEILING_MS = 30_000
export const RELAY_STABLE_CONNECTION_MS = RELAY_BACKOFF_CEILING_MS
const RELAY_HOST_OFFLINE_RETRY_MIN_MS = 5_000
const RELAY_HOST_OFFLINE_RETRY_MAX_MS = 15_000
// Why: gates must slow recovery down, never end it — a relay-only phone has no
// direct path to refresh credentials, so a timerless gate is a permanent outage.
// The cadence escalates and jitters so a permanently revoked device is not a
// forever one-minute beacon and a fleet-wide gating event cannot phase-align.
const RELAY_GATE_REPROBE_BASE_MS = 60_000
const RELAY_GATE_REPROBE_CEILING_MS = 15 * 60_000

// Every relay retry delay in one place: transport backoff, known-offline
// polling, and the escalating gated reprobe cadence, all jittered.
export class RelayRetryDelays {
  constructor(private readonly randomBytes: (length: number) => Uint8Array) {}

  transportDelayMs(consecutiveFailures: number): number {
    const exponent = Math.max(0, consecutiveFailures - 1)
    const cap = Math.min(RELAY_BACKOFF_CEILING_MS, RELAY_BACKOFF_BASE_MS * 2 ** exponent)
    // Full jitter (uniform in [0, cap)), floored so retries never busy-loop.
    return Math.max(RELAY_BACKOFF_MIN_MS, Math.floor(cap * this.jitterFraction()))
  }

  hostOfflineDelayMs(): number {
    const range = RELAY_HOST_OFFLINE_RETRY_MAX_MS - RELAY_HOST_OFFLINE_RETRY_MIN_MS
    return RELAY_HOST_OFFLINE_RETRY_MIN_MS + Math.floor(range * this.jitterFraction())
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
