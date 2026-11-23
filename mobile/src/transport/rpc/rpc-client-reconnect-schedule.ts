import type { ForegroundNudgeReason } from '../connection/connection-state'

const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000, 15_000, 30_000, 60_000]
export const RPC_RECONNECT_ATTEMPT_LIMIT = 12
const TRICKLE_RECONNECT_DELAY_MS = 90_000
const NETWORK_HINT_QUIET_MS = 10_000

type ReconnectScheduleOptions = {
  openConnection: () => void
  rejectConnectWaiters: (reason: string) => void
  emitLog: (message: string, detail: string) => void
}

export class RpcClientReconnectSchedule {
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastNetworkHintAt: number | null = null

  constructor(private readonly options: ReconnectScheduleOptions) {}

  getAttempt(): number {
    return this.attempt
  }

  authenticated(): void {
    this.attempt = 0
    this.lastNetworkHintAt = null
  }

  schedule(): void {
    const trickle = this.attempt >= RPC_RECONNECT_ATTEMPT_LIMIT
    let delayMs: number
    if (trickle) {
      delayMs = TRICKLE_RECONNECT_DELAY_MS
      this.options.rejectConnectWaiters('Connection retry limit reached')
    } else {
      delayMs = RECONNECT_DELAYS[Math.min(this.attempt, RECONNECT_DELAYS.length - 1)]!
      this.attempt++
    }
    console.log('[net] scheduleReconnect', {
      delayMs,
      attempt: this.attempt,
      trickle
    })
    this.options.emitLog(
      `Reconnect scheduled in ${delayMs}ms`,
      trickle ? `Attempt ${this.attempt} (slow retry)` : `Attempt ${this.attempt}`
    )
    this.timer = setTimeout(() => {
      this.timer = null
      this.options.openConnection()
    }, delayMs)
  }

  claimExpeditedRetry(reason: ForegroundNudgeReason): boolean {
    if (reason !== 'network-change') {
      return true
    }
    // Coalesce noisy iOS callbacks while allowing a later, separate network change to recover.
    const now = performance.now()
    const previous = this.lastNetworkHintAt
    this.lastNetworkHintAt = now
    return previous === null || now - previous >= NETWORK_HINT_QUIET_MS
  }

  redialNow(): void {
    this.cancel()
    this.options.openConnection()
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
