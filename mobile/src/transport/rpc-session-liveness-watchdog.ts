export const LIVENESS_IDLE_MS = 20_000
export const LIVENESS_PROBE_TIMEOUT_MS = 8_000
export const MISSED_PROBE_LIMIT = 3

export type RpcSessionIdentity = object

type WatchdogOptions = {
  transport: 'direct' | 'relay'
  sendProbe: (identity: RpcSessionIdentity) => boolean
  terminate: (identity: RpcSessionIdentity) => void
  onTimeout?: (evidence: LivenessTimeoutEvidence) => void
  idleProbeMs?: number | null
  probeTimeoutMs?: number
  missedProbeLimit?: number
  voluntaryProbeMinIntervalMs?: number
  // Bounds for probeImmediately(); default to the ordinary probe bounds.
  urgentProbeTimeoutMs?: number
  urgentMissedProbeLimit?: number
  // Gates the idle sweep only. False re-arms without probing — a backgrounded app
  // must not spend a probe, and its resume probes immediately anyway.
  shouldIdleProbe?: () => boolean
  now?: () => number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

type ProbeProfile = { timeoutMs: number; missedProbeLimit: number }

export type LivenessTimeoutEvidence = {
  transport: 'direct' | 'relay'
  reason: 'probe-send-failed' | 'probe-timeout'
  missedProbes: number
  missedProbeLimit: number
  lastInboundAgeMs: number
}

export class RpcSessionLivenessWatchdog {
  private identity: RpcSessionIdentity | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private probing = false
  private missedProbes = 0
  private lastInboundAt = 0
  private lastVoluntaryProbeAt: number | null = null
  private profile: ProbeProfile
  private readonly idleProbeMs: number | null
  private readonly ordinaryProfile: ProbeProfile
  private readonly urgentProfile: ProbeProfile
  private readonly voluntaryProbeMinIntervalMs: number
  private readonly now: () => number
  private readonly setTimer: typeof setTimeout
  private readonly clearTimer: typeof clearTimeout

  constructor(private readonly options: WatchdogOptions) {
    this.idleProbeMs = options.idleProbeMs === undefined ? LIVENESS_IDLE_MS : options.idleProbeMs
    this.ordinaryProfile = {
      timeoutMs: options.probeTimeoutMs ?? LIVENESS_PROBE_TIMEOUT_MS,
      missedProbeLimit: options.missedProbeLimit ?? MISSED_PROBE_LIMIT
    }
    this.urgentProfile = {
      timeoutMs: options.urgentProbeTimeoutMs ?? this.ordinaryProfile.timeoutMs,
      missedProbeLimit: options.urgentMissedProbeLimit ?? this.ordinaryProfile.missedProbeLimit
    }
    this.profile = this.ordinaryProfile
    this.voluntaryProbeMinIntervalMs = options.voluntaryProbeMinIntervalMs ?? 0
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
  }

  start(identity: RpcSessionIdentity): void {
    this.clearActiveTimer()
    this.identity = identity
    this.probing = false
    this.missedProbes = 0
    this.lastInboundAt = this.now()
    this.lastVoluntaryProbeAt = null
    this.profile = this.ordinaryProfile
    this.armIdle(identity)
  }

  // Wall-clock stamp of the last frame that actually arrived; 0 before the first
  // start(). Unlike a timer deadline this survives a JS suspension, so callers can
  // tell how stale their knowledge of the peer really is.
  getLastInboundAt(): number {
    return this.lastInboundAt
  }

  noteAuthenticatedInbound(identity: RpcSessionIdentity): void {
    if (this.identity !== identity) {
      return
    }
    this.lastInboundAt = this.now()
    if (this.missedProbes > 0) {
      console.log('[net] activity-probe recovered', {
        transport: this.options.transport,
        priorMissedProbes: this.missedProbes
      })
    }
    if (!this.probing && this.missedProbes === 0) {
      return
    }
    this.missedProbes = 0
    this.probing = false
    this.armIdle(identity)
  }

  // 'resume' is evidence the socket may have died while the process was suspended:
  // it ignores the voluntary minimum, runs on the urgent bounds, and replaces any
  // probe already in flight so the verdict lands on the short clock.
  probeNow(identity: RpcSessionIdentity, urgency: 'nudge' | 'resume' = 'nudge'): void {
    const urgent = urgency === 'resume'
    if (this.identity !== identity || (this.probing && !urgent)) {
      return
    }
    const now = this.now()
    if (
      !urgent &&
      this.lastVoluntaryProbeAt !== null &&
      now - this.lastVoluntaryProbeAt < this.voluntaryProbeMinIntervalMs
    ) {
      return
    }
    this.lastVoluntaryProbeAt = now
    this.startProbe(identity, urgent ? this.urgentProfile : this.ordinaryProfile)
  }

  stop(identity: RpcSessionIdentity): void {
    if (this.identity !== identity) {
      return
    }
    this.clearActiveTimer()
    this.identity = null
    this.probing = false
    this.missedProbes = 0
    this.lastInboundAt = 0
    this.lastVoluntaryProbeAt = null
    this.profile = this.ordinaryProfile
  }

  private armIdle(identity: RpcSessionIdentity, delayMs = this.idleProbeMs): void {
    this.clearActiveTimer()
    if (delayMs === null) {
      return
    }
    this.timer = this.setTimer(() => {
      this.timer = null
      if (this.identity !== identity) {
        return
      }
      if (this.options.shouldIdleProbe && !this.options.shouldIdleProbe()) {
        this.armIdle(identity)
        return
      }
      const idleMs = this.now() - this.lastInboundAt
      if (this.idleProbeMs !== null && idleMs < this.idleProbeMs) {
        this.armIdle(identity, Math.max(1, this.idleProbeMs - Math.max(0, idleMs)))
      } else {
        this.startProbe(identity)
      }
    }, delayMs)
  }

  private startProbe(identity: RpcSessionIdentity, profile = this.ordinaryProfile): void {
    if (this.identity !== identity) {
      return
    }
    this.clearActiveTimer()
    this.profile = profile
    this.probing = true
    const sentAt = this.now()
    let sent = false
    try {
      sent = this.options.sendProbe(identity)
    } catch {
      sent = false
    }
    if (!sent) {
      this.terminateCurrent(identity, 'probe-send-failed')
      return
    }
    this.timer = this.setTimer(() => this.handleProbeTimeout(identity, sentAt), profile.timeoutMs)
  }

  private handleProbeTimeout(identity: RpcSessionIdentity, sentAt: number): void {
    this.timer = null
    if (this.identity !== identity) {
      return
    }
    const profile = this.profile
    const elapsedMs = this.now() - sentAt
    if (elapsedMs < 0 || elapsedMs > profile.timeoutMs * 1.5) {
      console.log('[net] activity-probe unfair window skipped', {
        transport: this.options.transport,
        elapsedMs,
        timeoutMs: profile.timeoutMs
      })
      this.startProbe(identity, profile)
      return
    }
    this.missedProbes += 1
    if (this.missedProbes >= profile.missedProbeLimit) {
      this.terminateCurrent(identity, 'probe-timeout')
      return
    }
    console.log('[net] activity-probe timeout tolerated', {
      transport: this.options.transport,
      missedProbes: this.missedProbes,
      missedProbeLimit: profile.missedProbeLimit
    })
    this.startProbe(identity, profile)
  }

  private terminateCurrent(
    identity: RpcSessionIdentity,
    reason: LivenessTimeoutEvidence['reason']
  ): void {
    if (this.identity !== identity) {
      return
    }
    this.clearActiveTimer()
    this.identity = null
    this.probing = false
    console.log('[net] activity-probe TIMEOUT — forcing reconnect', {
      transport: this.options.transport,
      missedProbes: this.missedProbes,
      missedProbeLimit: this.profile.missedProbeLimit
    })
    this.options.onTimeout?.({
      transport: this.options.transport,
      reason,
      missedProbes: this.missedProbes,
      missedProbeLimit: this.profile.missedProbeLimit,
      lastInboundAgeMs: Math.max(0, this.now() - this.lastInboundAt)
    })
    this.options.terminate(identity)
  }

  private clearActiveTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
  }
}
