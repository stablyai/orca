import type { MobileRelayRpcSession } from './mobile-relay-rpc-session'

const LEASE_ROTATION_MARGIN_MS = 30_000

export class MobileEndpointSupervisorTimers {
  private retry: ReturnType<typeof setTimeout> | null = null
  private lease: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly setTimer: typeof setTimeout,
    private readonly clearTimer: typeof clearTimeout
  ) {}

  scheduleRetry(delay: number, retry: () => void): void {
    this.clearRetry()
    this.retry = this.setTimer(() => {
      this.retry = null
      retry()
    }, delay)
  }

  scheduleLease(session: MobileRelayRpcSession, now: () => number, rotate: () => void): void {
    this.clearAll()
    const deadline = session.getLeaseExpiresAt()
    if (!deadline) {
      return
    }
    const delay = Math.max(1_000, deadline - now() - LEASE_ROTATION_MARGIN_MS)
    this.lease = this.setTimer(() => {
      this.lease = null
      rotate()
    }, delay)
  }

  clearRetry(): void {
    if (this.retry) {
      this.clearTimer(this.retry)
      this.retry = null
    }
  }

  hasScheduled(): boolean {
    return this.retry !== null || this.lease !== null
  }

  clearAll(): void {
    this.clearRetry()
    this.clearLease()
  }

  private clearLease(): void {
    if (this.lease) {
      this.clearTimer(this.lease)
      this.lease = null
    }
  }
}
