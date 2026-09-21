import type { RelayReconnectController } from './mobile-relay-reconnect-controller'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'

// Retain a healthy Relay briefly across routine app switches without waking the app.
export const RELAY_BACKGROUND_GRACE_MS = 30_000

type RelayBackgroundGraceDependencies = {
  now: () => number
  setTimer: typeof setTimeout
  clearTimer: typeof clearTimeout
}

export class MobileRelayBackgroundGraceTimer {
  private deadlineAt: number | null = null
  private generation = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly dependencies: RelayBackgroundGraceDependencies,
    private readonly onExpired: () => void
  ) {}

  arm(): void {
    this.clear()
    this.deadlineAt = this.dependencies.now() + RELAY_BACKGROUND_GRACE_MS
    const generation = this.generation
    this.timer = this.dependencies.setTimer(() => {
      if (generation !== this.generation || this.deadlineAt === null) {
        return
      }
      this.timer = null
      this.deadlineAt = null
      this.onExpired()
    }, RELAY_BACKGROUND_GRACE_MS)
  }

  consumeExpired(): boolean {
    const expired = this.deadlineAt !== null && this.dependencies.now() >= this.deadlineAt
    this.clear()
    return expired
  }

  clear(): void {
    this.generation += 1
    this.deadlineAt = null
    if (this.timer !== null) {
      this.dependencies.clearTimer(this.timer)
      this.timer = null
    }
  }
}

type Clearable = { clear(): void }
type DirectProbe = Clearable & { schedule(delayMs?: number): void }
type DirectGrace = Clearable & { arm(): void }

export class MobileRelayBackgroundGrace {
  private foregroundState = true
  private retainedRelaySuspended = false
  private readonly timer: MobileRelayBackgroundGraceTimer

  constructor(
    dependencies: RelayBackgroundGraceDependencies,
    private readonly logical: StableLogicalRpcClient,
    private readonly relayReconnect: RelayReconnectController,
    private readonly leaseRotation: Clearable,
    private readonly directProbe: DirectProbe,
    private readonly directGrace: DirectGrace
  ) {
    this.timer = new MobileRelayBackgroundGraceTimer(dependencies, () => this.suspendRelay())
  }

  isForeground(): boolean {
    return this.foregroundState
  }

  setForeground(foreground: boolean): void {
    const wasForeground = this.foregroundState
    this.foregroundState = foreground
    if (foreground) {
      this.foreground()
      this.relayReconnect.handleForeground(this.logical, wasForeground)
      this.directProbe.schedule(0)
      this.directGrace.arm()
    } else if (wasForeground) {
      this.background()
    }
  }

  stop(): void {
    this.timer.clear()
    this.directProbe.clear()
    this.relayReconnect.clear()
    this.leaseRotation.clear()
    this.directGrace.clear()
    this.logical.setRecoveryPath(null)
  }

  handleStateFailure(): void {
    this.timer.clear()
    if (this.logical.getActivePath() === 'relay') {
      this.suspendRelay()
    }
  }

  private background(): void {
    this.retainedRelaySuspended = false
    const retainsRelay =
      this.logical.getActivePath() === 'relay' && this.logical.getState() === 'connected'
    this.directProbe.clear()
    this.directGrace.clear()
    this.logical.setRecoveryPath(null)
    if (retainsRelay) {
      this.timer.arm()
      return
    }
    this.relayReconnect.clear()
    this.leaseRotation.clear()
    if (this.logical.getActivePath() === 'relay') {
      this.suspendRelay()
    }
  }

  private foreground(): void {
    if (this.timer.consumeExpired()) {
      this.suspendRelay()
    }
  }

  private suspendRelay(): void {
    if (this.retainedRelaySuspended || this.logical.getActivePath() !== 'relay') {
      return
    }
    this.retainedRelaySuspended = true
    this.timer.clear()
    this.leaseRotation.clear()
    this.relayReconnect.suspendActiveRelay(this.logical)
  }
}
