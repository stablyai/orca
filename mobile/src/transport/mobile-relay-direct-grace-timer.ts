import type { StableLogicalRpcClient } from './stable-logical-rpc-client'

// Why: on a black-holed LAN endpoint the direct dial sits in 'connecting' for the
// whole 12s connect timeout (rpc-client CONNECT_TIMEOUT_MS), and relay recovery
// cannot even start meanwhile because connecting/handshaking count as live direct
// progress. Happy eyeballs: give direct this much of a head start, then race the
// relay dial — migrateTo hands the logical client to whichever authenticates first.
const DIRECT_DIAL_GRACE_MS = 2500

type DirectGraceTimerDependencies = {
  setTimer: typeof setTimeout
  clearTimer: typeof clearTimeout
}

// One-shot timer that releases the relay dial when the direct dial has not
// authenticated within the grace. The supervisor arms it at start and on
// foreground restore, and clears it on connect, background, and stop.
export class MobileRelayDirectGraceTimer {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly dependencies: DirectGraceTimerDependencies,
    private readonly logical: StableLogicalRpcClient,
    private readonly dialRelay: () => void
  ) {}

  // No-op unless the direct dial is still unauthenticated, so a healthy LAN and
  // an already-failed direct path (recovery owns that) never open a relay socket.
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
