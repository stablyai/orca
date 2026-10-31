import { defaultCancelTimer, defaultScheduleTimer, type ScheduleTimer } from './timer-scheduler'

export const LIVENESS_IDLE_MS = 20_000
export const LIVENESS_PROBE_TIMEOUT_MS = 8_000
export const MISSED_PROBE_LIMIT = 3
// One miss ends a session already suspected dead; long enough for radio wake and TCP retransmit before redial.
export const DECISIVE_PROBE_TIMEOUT_MS = 4_000

declare const rpcSessionIdentityBrand: unique symbol

/** Opaque per-session token; only ever compared by reference. */
export type RpcSessionIdentity = object & { readonly [rpcSessionIdentityBrand]?: never }

type WatchdogOptions = {
  transport: 'direct' | 'relay'
  sendProbe: (identity: RpcSessionIdentity) => boolean
  terminate: (identity: RpcSessionIdentity) => void
  onTimeout?: (evidence: LivenessTimeoutEvidence) => void
  idleProbeMs?: number | null
  probeTimeoutMs?: number
  missedProbeLimit?: number
  voluntaryProbeMinIntervalMs?: number
  now?: () => number
  setTimer?: ScheduleTimer
  clearTimer?: typeof clearTimeout
}

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
  private probingDecisively = false
  private missedProbes = 0
  private lastInboundAt = 0
  private lastVoluntaryProbeAt: number | null = null
  private lastDecisiveProbeAt: number | null = null
  private readonly idleProbeMs: number | null
  private readonly probeTimeoutMs: number
  private readonly missedProbeLimit: number
  private readonly voluntaryProbeMinIntervalMs: number
  private readonly now: () => number
  private readonly setTimer: ScheduleTimer
  private readonly clearTimer: typeof clearTimeout

  constructor(private readonly options: WatchdogOptions) {
    this.idleProbeMs = options.idleProbeMs === undefined ? LIVENESS_IDLE_MS : options.idleProbeMs
    this.probeTimeoutMs = options.probeTimeoutMs ?? LIVENESS_PROBE_TIMEOUT_MS
    this.missedProbeLimit = options.missedProbeLimit ?? MISSED_PROBE_LIMIT
    this.voluntaryProbeMinIntervalMs = options.voluntaryProbeMinIntervalMs ?? 0
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? defaultScheduleTimer
    this.clearTimer = options.clearTimer ?? defaultCancelTimer
  }

  start(identity: RpcSessionIdentity): void {
    this.clearActiveTimer()
    this.identity = identity
    this.probing = false
    this.missedProbes = 0
    this.lastInboundAt = this.now()
    this.lastVoluntaryProbeAt = null
    this.lastDecisiveProbeAt = null
    this.armIdle(identity)
  }

  // Wall-clock evidence survives JS suspension; initialized at start and refreshed only by authenticated frames.
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

  // A decisive probe ends the session on its first miss when suspension may have killed the link.
  probeNow(identity: RpcSessionIdentity, decisiveTimeoutMs: number | null = null): void {
    this.requestProbe(identity, decisiveTimeoutMs)
  }

  // A distinct background stay invalidates recent health evidence, but not an already running deadline.
  probeAfterBackground(identity: RpcSessionIdentity): void {
    this.requestProbe(identity, DECISIVE_PROBE_TIMEOUT_MS, true)
  }

  private requestProbe(
    identity: RpcSessionIdentity,
    decisiveTimeoutMs: number | null,
    afterBackground = false
  ): void {
    const decisive = decisiveTimeoutMs !== null
    if (this.identity !== identity || (this.probing && (!decisive || this.probingDecisively))) {
      return
    }
    const now = this.now()
    const lastProbeAt = decisive ? this.lastDecisiveProbeAt : this.lastVoluntaryProbeAt
    const minIntervalMs = decisive
      ? Math.min(this.voluntaryProbeMinIntervalMs, decisiveTimeoutMs)
      : this.voluntaryProbeMinIntervalMs
    if (
      !afterBackground &&
      !this.probing &&
      lastProbeAt !== null &&
      now - lastProbeAt < minIntervalMs
    ) {
      if (decisive) {
        this.clearActiveTimer()
        this.timer = this.setTimer(
          () => {
            this.timer = null
            this.requestProbe(identity, decisiveTimeoutMs)
          },
          minIntervalMs - (now - lastProbeAt)
        )
      }
      return
    }
    this.lastVoluntaryProbeAt = now
    if (decisive) {
      this.lastDecisiveProbeAt = now
    }
    this.startProbe(identity, decisiveTimeoutMs)
  }

  // For a caller that stopped hearing back: a session heard from within the window is not suspect, no foreground rate limit applies, and a tolerant probe already running is cut short.
  probeCurrentDecisively(): void {
    const identity = this.identity
    const decisiveRunning = this.probing && this.probingDecisively
    if (
      identity &&
      !decisiveRunning &&
      this.now() - this.lastInboundAt >= DECISIVE_PROBE_TIMEOUT_MS
    ) {
      this.startProbe(identity, DECISIVE_PROBE_TIMEOUT_MS)
    }
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
    this.lastDecisiveProbeAt = null
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
      const idleMs = this.now() - this.lastInboundAt
      if (this.idleProbeMs !== null && idleMs < this.idleProbeMs) {
        this.armIdle(identity, Math.max(1, this.idleProbeMs - Math.max(0, idleMs)))
      } else {
        this.startProbe(identity)
      }
    }, delayMs)
  }

  private startProbe(identity: RpcSessionIdentity, decisiveTimeoutMs: number | null = null): void {
    if (this.identity !== identity) {
      return
    }
    this.clearActiveTimer()
    this.probing = true
    this.probingDecisively = decisiveTimeoutMs !== null
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
    this.timer = this.setTimer(
      () => this.handleProbeTimeout(identity, sentAt, decisiveTimeoutMs),
      decisiveTimeoutMs ?? this.probeTimeoutMs
    )
  }

  private handleProbeTimeout(
    identity: RpcSessionIdentity,
    sentAt: number,
    decisiveTimeoutMs: number | null
  ): void {
    this.timer = null
    if (this.identity !== identity) {
      return
    }
    const timeoutMs = decisiveTimeoutMs ?? this.probeTimeoutMs
    const elapsedMs = this.now() - sentAt
    if (elapsedMs < 0 || elapsedMs > timeoutMs * 1.5) {
      console.log('[net] activity-probe unfair window skipped', {
        transport: this.options.transport,
        elapsedMs,
        timeoutMs
      })
      this.startProbe(identity, decisiveTimeoutMs)
      return
    }
    this.missedProbes += 1
    const missedProbeLimit = decisiveTimeoutMs === null ? this.missedProbeLimit : 1
    if (this.missedProbes >= missedProbeLimit) {
      this.terminateCurrent(identity, 'probe-timeout', missedProbeLimit)
      return
    }
    console.log('[net] activity-probe timeout tolerated', {
      transport: this.options.transport,
      missedProbes: this.missedProbes,
      missedProbeLimit: this.missedProbeLimit
    })
    this.startProbe(identity)
  }

  private terminateCurrent(
    identity: RpcSessionIdentity,
    reason: LivenessTimeoutEvidence['reason'],
    missedProbeLimit = this.missedProbeLimit
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
      missedProbeLimit
    })
    this.options.onTimeout?.({
      transport: this.options.transport,
      reason,
      missedProbes: this.missedProbes,
      missedProbeLimit,
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
