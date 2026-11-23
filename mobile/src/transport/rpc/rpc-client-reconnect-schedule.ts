import { isAppOutsideForeground } from '../connection/socket-deadline-clock'
import type { ForegroundNudgeReason } from '../connection/connection-state'

const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000, 15_000, 30_000, 60_000]
export const RPC_RECONNECT_ATTEMPT_LIMIT = 12
const TRICKLE_RECONNECT_DELAY_MS = 90_000
const DORMANT_TAILNET_RETRY_MS = 5 * 60_000
const DORMANT_TAILNET_MIN_RETRY_MS = 120_000
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
  private expeditedDial: 'first-network-hint' | 'other' | null = null
  private lastDormantResumeAt: number | null = null

  constructor(private readonly options: ReconnectScheduleOptions) {}

  getAttempt(): number {
    return this.attempt
  }

  authenticated(): void {
    this.attempt = 0
    this.connectedOnce = true
    this.lastNetworkHintAt = null
    this.expeditedDial = null
    this.clearNetworkFollowUp()
  }

  schedule(): void {
    const retryDelay = RECONNECT_DELAYS[Math.min(this.attempt, RECONNECT_DELAYS.length - 1)]!
    const exhausted = this.attempt >= RPC_RECONNECT_ATTEMPT_LIMIT
    const expeditedDial = this.expeditedDial
    this.expeditedDial = null
    // Extra attention hints should not push an offline host through the regular backoff ladder.
    if (expeditedDial === null) {
      this.attempt = Math.min(this.attempt + 1, RPC_RECONNECT_ATTEMPT_LIMIT)
    }
    const dormant = this.isDormant()
    const retrySoon = expeditedDial === 'first-network-hint' && !dormant
    const slow = (exhausted || dormant) && !retrySoon
    const backoffMs = dormant
      ? DORMANT_TAILNET_RETRY_MS
      : exhausted
        ? TRICKLE_RECONNECT_DELAY_MS
        : retryDelay
    const delayMs = retrySoon ? Math.min(NETWORK_FOLLOW_UP_DELAY_MS, backoffMs) : backoffMs
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

  private isDormant(): boolean {
    return (
      this.options.tailnetEndpoint &&
      !this.connectedOnce &&
      this.attempt >= RPC_RECONNECT_ATTEMPT_LIMIT
    )
  }

  canRetryFromHint(reason: ForegroundNudgeReason, dialAgeMs: number): boolean {
    if (reason === 'focus' || !this.isDormant()) {
      return true
    }
    if (isAppOutsideForeground()) {
      return false
    }
    if (reason === 'app-resume') {
      const lastResume = this.lastDormantResumeAt
      // Returning from Tailscale settings can restore the path just after an automatic dial failed.
      return lastResume === null || Date.now() - lastResume >= DORMANT_TAILNET_MIN_RETRY_MS
    }
    return dialAgeMs >= DORMANT_TAILNET_MIN_RETRY_MS
  }

  retryAfterNetworkHint(retry: (followUp: boolean) => void): void {
    const now = Date.now()
    const previous = this.lastNetworkHintAt
    this.lastNetworkHintAt = now
    if (previous === null || now < previous || now - previous >= NETWORK_HINT_QUIET_MS) {
      this.clearNetworkFollowUp()
      this.networkFollowUpUsed = false
      retry(false)
    } else if (!this.networkFollowUpUsed && !this.isDormant()) {
      // An early hint can arrive before the new path works. Give the burst one follow-up.
      this.networkFollowUpUsed = true
      this.networkFollowUpTimer = setTimeout(() => {
        this.networkFollowUpTimer = null
        retry(true)
      }, NETWORK_FOLLOW_UP_DELAY_MS)
    }
  }

  redialNow(reason: ForegroundNudgeReason, fromBackoff: boolean, followUp: boolean): void {
    this.clearBackoff()
    const firstNetworkHint = reason === 'network-change' && !followUp
    this.expeditedDial = firstNetworkHint ? 'first-network-hint' : 'other'
    if (reason === 'app-resume') {
      if (this.isDormant()) {
        this.lastDormantResumeAt = Date.now()
      } else if (fromBackoff) {
        this.attempt = 0
      }
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
