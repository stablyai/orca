import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ScheduleTimer } from './timer-scheduler'

// Give direct a head start, then race relay so a black-holed LAN cannot block recovery for its whole connect deadline.
const DIRECT_DIAL_GRACE_MS = 2500

type DirectGraceTimerDependencies = {
  setTimer: ScheduleTimer
  clearTimer: typeof clearTimeout
}

export class MobileRelayDirectGraceTimer {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly dependencies: DirectGraceTimerDependencies,
    private readonly logical: StableLogicalRpcClient,
    private readonly dialRelay: () => void
  ) {}

  // Race only unauthenticated direct progress; healthy LAN and already-failed direct recovery need no extra relay socket.
  arm(): void {
    const state = this.logical.getState()
    if (this.timer || (state !== 'connecting' && state !== 'handshaking')) {
      return
    }
    this.timer = this.dependencies.setTimer(() => {
      this.timer = null
      if (this.logical.getState() !== 'connected') {
        this.dialRelay()
      }
    }, DIRECT_DIAL_GRACE_MS)
  }

  clear(): void {
    if (this.timer) {
      this.dependencies.clearTimer(this.timer)
      this.timer = null
    }
  }
}
