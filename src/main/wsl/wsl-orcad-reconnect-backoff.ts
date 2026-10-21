import { withReconnectJitter } from '../../shared/reconnect-jitter'

/** A relaunch on a warm VM measured ~0.9 s; a slow deploy ~11 s. Seven tries span ~1 minute. */
export const WSL_ORCAD_RECONNECT_DELAYS_MS = [250, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000]
/** Re-checks of an unanswered probe never give up; a failed probe proves nothing. */
export const WSL_ORCAD_VERIFY_RETRY_CAP_MS = 30_000
/** A connection that stayed ready this long restarts the ladder on its next drop. */
export const WSL_ORCAD_STABLE_MS = 60_000

export type WslOrcadReconnectDecision =
  | { kind: 'retry'; attempt: number; delayMs: number }
  | { kind: 'give-up'; attempts: number }

/** Bounded relaunch ladder. Every time is monotonic (`performance.now`), never `Date`. */
export class WslOrcadReconnectBackoff {
  private attempts = 0
  private readyAtMs: number | null = null

  constructor(private readonly random: () => number = Math.random) {}

  noteReady(monotonicNowMs: number): void {
    this.readyAtMs = monotonicNowMs
  }

  next(monotonicNowMs: number): WslOrcadReconnectDecision {
    const readyAt = this.readyAtMs
    this.readyAtMs = null
    if (readyAt !== null && monotonicNowMs - readyAt >= WSL_ORCAD_STABLE_MS) {
      this.attempts = 0
    }
    if (this.attempts >= WSL_ORCAD_RECONNECT_DELAYS_MS.length) {
      return { kind: 'give-up', attempts: this.attempts }
    }
    const delay = WSL_ORCAD_RECONNECT_DELAYS_MS[this.attempts]
    this.attempts += 1
    return {
      kind: 'retry',
      attempt: this.attempts,
      delayMs: withReconnectJitter(delay, this.random)
    }
  }

  reset(): void {
    this.attempts = 0
    this.readyAtMs = null
  }
}

/** Unverifiable re-checks: double from 1 s up to the cap, forever. */
export function wslOrcadVerifyRetryDelayMs(streak: number): number {
  return Math.min(WSL_ORCAD_VERIFY_RETRY_CAP_MS, 1_000 * 2 ** Math.max(0, streak))
}
