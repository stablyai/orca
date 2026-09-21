import type { AgentStatusState } from '../shared/agent-status-types'

export const AGENT_AWAKE_STATUS_STALE_AFTER_MS = 2 * 60 * 60 * 1000

export type AgentAwakeStatus = {
  paneKey: string
  state: AgentStatusState
  receivedAt: number
  observedInCurrentRuntime: boolean
}

export class AgentAwakeStatusLease {
  private statuses = new Map<string, AgentAwakeStatus>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private timerExpiresAt: number | null = null

  constructor(
    private readonly now: () => number,
    private readonly onExpiry: () => void
  ) {}

  replace(statuses: AgentAwakeStatus[]): void {
    this.statuses = new Map(statuses.map((status) => [status.paneKey, status]))
    this.scheduleNextExpiry()
  }

  /** Returns whether the renewed row is currently wake-eligible. */
  renew(status: AgentAwakeStatus): boolean {
    this.statuses.set(status.paneKey, status)
    const now = this.now()
    if (!this.isEligible(status, now)) {
      return false
    }
    this.scheduleAt(status.receivedAt + AGENT_AWAKE_STATUS_STALE_AFTER_MS, now)
    return true
  }

  countEligible(): number {
    const now = this.now()
    let count = 0
    for (const status of this.statuses.values()) {
      if (this.isEligible(status, now)) {
        count += 1
      }
    }
    return count
  }

  dispose(): void {
    this.clearTimer()
  }

  private isEligible(status: AgentAwakeStatus, now: number): boolean {
    return (
      status.observedInCurrentRuntime &&
      status.state === 'working' &&
      Number.isFinite(status.receivedAt) &&
      now - status.receivedAt <= AGENT_AWAKE_STATUS_STALE_AFTER_MS
    )
  }

  private scheduleNextExpiry(): void {
    this.clearTimer()
    const now = this.now()
    let earliestExpiry: number | null = null
    for (const status of this.statuses.values()) {
      if (!this.isEligible(status, now)) {
        continue
      }
      const expiry = status.receivedAt + AGENT_AWAKE_STATUS_STALE_AFTER_MS
      const nextCheckAt = expiry === now ? now + 1 : expiry
      earliestExpiry = earliestExpiry === null ? nextCheckAt : Math.min(earliestExpiry, nextCheckAt)
    }
    if (earliestExpiry !== null) {
      this.scheduleAt(earliestExpiry, now)
    }
  }

  private scheduleAt(expiry: number, now: number): void {
    if (
      expiry <= now ||
      (this.timer !== null && this.timerExpiresAt !== null && this.timerExpiresAt <= expiry)
    ) {
      return
    }
    this.clearTimer()
    this.timerExpiresAt = expiry
    this.timer = setTimeout(() => {
      this.timer = null
      this.timerExpiresAt = null
      this.scheduleNextExpiry()
      this.onExpiry()
    }, expiry - now)
    if (typeof this.timer.unref === 'function') {
      this.timer.unref()
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.timerExpiresAt = null
  }
}
