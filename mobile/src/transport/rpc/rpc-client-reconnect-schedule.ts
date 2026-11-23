import { isAppOutsideForeground } from '../connection/socket-deadline-clock'

const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000, 15_000, 30_000, 60_000]
export const RPC_RECONNECT_ATTEMPT_LIMIT = 12
const TRICKLE_RECONNECT_DELAY_MS = 90_000
const DORMANT_TAILNET_RETRY_MS = 5 * 60_000
const NETWORK_HINT_QUIET_MS = 30_000
const NETWORK_FOLLOW_UP_DELAY_MS = 2_000

type ReconnectScheduleOptions = {
  tailnetEndpoint: boolean
  openConnection: () => void
  rejectConnectWaiters: (reason: string) => void
  emitLog: (message: string, detail: string) => void
}

export class RpcClientReconnectSchedule {
  private attempt = 0
  private connectedOnce = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastNetworkHintAt: number | null = null
  private networkFollowUpUsed = false
  private networkFollowUpTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: ReconnectScheduleOptions) {}

  getAttempt(): number {
    return this.attempt
  }

  authenticated(): void {
    this.attempt = 0
    this.connectedOnce = true
    this.lastNetworkHintAt = null
    this.clearNetworkFollowUp()
  }

  schedule(): void {
    const retryDelay = RECONNECT_DELAYS[Math.min(this.attempt, RECONNECT_DELAYS.length - 1)]!
    const exhausted = this.attempt >= RPC_RECONNECT_ATTEMPT_LIMIT
    this.attempt = Math.min(this.attempt + 1, RPC_RECONNECT_ATTEMPT_LIMIT)
    const dormant = this.isDormant()
    const slow = exhausted || dormant
    const delayMs = dormant
      ? DORMANT_TAILNET_RETRY_MS
      : exhausted
        ? TRICKLE_RECONNECT_DELAY_MS
        : retryDelay
    if (slow) {
      this.options.rejectConnectWaiters('Connection retry limit reached')
    }
    console.log('[net] scheduleReconnect', {
      delayMs,
      attempt: this.attempt,
      slow
    })
    this.options.emitLog(
      `Reconnect scheduled in ${delayMs}ms`,
      slow ? `Attempt ${this.attempt} (slow retry)` : `Attempt ${this.attempt}`
    )
    this.armBackoff(delayMs)
  }

  isDormant(): boolean {
    return (
      this.options.tailnetEndpoint &&
      !this.connectedOnce &&
      this.attempt >= RPC_RECONNECT_ATTEMPT_LIMIT
    )
  }

  retryAfterNetworkHint(retry: () => void): void {
    if (this.isDormant()) {
      return
    }
    const now = Date.now()
    const previous = this.lastNetworkHintAt
    this.lastNetworkHintAt = now
    if (previous === null || now - previous >= NETWORK_HINT_QUIET_MS) {
      this.clearNetworkFollowUp()
      this.networkFollowUpUsed = false
      retry()
    } else if (!this.networkFollowUpUsed) {
      // An early hint can arrive before the new path works. Give the burst one follow-up.
      this.networkFollowUpUsed = true
      this.networkFollowUpTimer = setTimeout(() => {
        this.networkFollowUpTimer = null
        retry()
      }, NETWORK_FOLLOW_UP_DELAY_MS)
    }
  }

  redialNow(resetAttempts: boolean): void {
    this.clearBackoff()
    if (resetAttempts) {
      this.attempt = 0
    }
    this.options.openConnection()
  }

  cancel(): void {
    this.clearBackoff()
    this.clearNetworkFollowUp()
  }

  private clearBackoff(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private armBackoff(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null
      // Leave a quiet period for WireGuard to release packets staged for an offline peer.
      if (this.isDormant() && isAppOutsideForeground()) {
        this.armBackoff(delayMs)
      } else {
        this.options.openConnection()
      }
    }, delayMs)
  }

  private clearNetworkFollowUp(): void {
    if (this.networkFollowUpTimer) {
      clearTimeout(this.networkFollowUpTimer)
      this.networkFollowUpTimer = null
    }
  }
}
