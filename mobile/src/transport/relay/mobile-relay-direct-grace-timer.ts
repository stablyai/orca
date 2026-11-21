import type { MobileEndpointSupervisorDependencies } from '../connection/mobile-endpoint-supervisor-contract'
import type { StableLogicalRpcClient } from '../connection/stable-logical-rpc-client'

// Give direct a head start, then race relay so a black-holed LAN cannot block recovery for its whole connect deadline.
const DIRECT_DIAL_GRACE_MS = 2500

type DirectGraceTimerDependencies = Pick<
  MobileEndpointSupervisorDependencies,
  'setTimer' | 'clearTimer' | 'lastGoodPathWasDirectHere' | 'recordGoodPath'
>

export class MobileRelayDirectGraceTimer {
  private timer: ReturnType<typeof setTimeout> | null = null
  // Unknown until the path memory is read; the head start is kept meanwhile.
  private directHeadStart: boolean | null = null
  private headStartSpent = false

  constructor(
    private readonly dependencies: DirectGraceTimerDependencies,
    private readonly logical: StableLogicalRpcClient,
    private readonly hostId: string,
    private readonly dialRelay: () => void
  ) {}

  // Off the network of the last good direct connection the head start only delays relay, so race from t=0.
  async loadLastGoodPath(): Promise<void> {
    if (this.logical.getState() === 'connected') {
      this.onConnected()
      return
    }
    const directHere = await this.dependencies.lastGoodPathWasDirectHere(this.hostId)
    // A connection made during the read is fresher than the stored record.
    this.directHeadStart ??= directHere
    if (!this.directHeadStart && this.timer) {
      this.clear()
      this.arm()
    }
  }

  // Once direct has had its head start this outage, relay retries run on their own backoff instead of waiting out each direct redial.
  raceUnderway(): boolean {
    return (
      this.headStartSpent &&
      this.logical.getActivePath() !== 'relay' &&
      this.logical.getState() !== 'connected'
    )
  }

  onConnected(): void {
    this.clear()
    const path = this.logical.getActivePath() === 'relay' ? 'relay' : 'direct'
    this.directHeadStart = path === 'direct'
    void this.dependencies.recordGoodPath(this.hostId, path)
  }

  // Race only unauthenticated direct progress; healthy LAN and already-failed direct recovery need no extra relay socket.
  arm(): void {
    const state = this.logical.getState()
    if (this.timer || (state !== 'connecting' && state !== 'handshaking')) {
      return
    }
    this.timer = this.dependencies.setTimer(
      () => {
        this.timer = null
        if (this.logical.getState() !== 'connected') {
          this.headStartSpent = true
          this.dialRelay()
        }
      },
      this.directHeadStart === false ? 0 : DIRECT_DIAL_GRACE_MS
    )
  }

  clear(): void {
    this.headStartSpent = false
    if (this.timer) {
      this.dependencies.clearTimer(this.timer)
      this.timer = null
    }
  }
}
