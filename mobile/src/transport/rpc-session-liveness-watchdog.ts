export const LIVENESS_IDLE_MS = 20_000
export const LIVENESS_PROBE_TIMEOUT_MS = 8_000
export const MISSED_PROBE_LIMIT = 3

export type RpcSessionIdentity = object

type WatchdogOptions = {
  transport: 'direct' | 'relay'
  sendProbe: (identity: RpcSessionIdentity) => boolean
  terminate: (identity: RpcSessionIdentity) => void
  idleProbeMs?: number | null
  probeTimeoutMs?: number
  missedProbeLimit?: number
  voluntaryProbeMinIntervalMs?: number
  now?: () => number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

export class RpcSessionLivenessWatchdog {
  private identity: RpcSessionIdentity | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private probing = false
  private missedProbes = 0
  private lastInboundAt = 0
  private lastVoluntaryProbeAt: number | null = null
  private readonly idleProbeMs: number | null
  private readonly probeTimeoutMs: number
  private readonly missedProbeLimit: number
  private readonly voluntaryProbeMinIntervalMs: number
  private readonly now: () => number
  private readonly setTimer: typeof setTimeout
  private readonly clearTimer: typeof clearTimeout

  constructor(private readonly options: WatchdogOptions) {
    this.idleProbeMs = options.idleProbeMs === undefined ? LIVENESS_IDLE_MS : options.idleProbeMs
    this.probeTimeoutMs = options.probeTimeoutMs ?? LIVENESS_PROBE_TIMEOUT_MS
    this.missedProbeLimit = options.missedProbeLimit ?? MISSED_PROBE_LIMIT
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
    this.armIdle(identity)
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

  probeNow(identity: RpcSessionIdentity): void {
    if (this.identity !== identity || this.probing) {
      return
    }
    const now = this.now()
    if (
      this.lastVoluntaryProbeAt !== null &&
      now - this.lastVoluntaryProbeAt < this.voluntaryProbeMinIntervalMs
    ) {
      return
    }
    this.lastVoluntaryProbeAt = now
    this.startProbe(identity)
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

  private startProbe(identity: RpcSessionIdentity): void {
    if (this.identity !== identity) {
      return
    }
    this.clearActiveTimer()
    this.probing = true
    const sentAt = this.now()
    let sent = false
    try {
      sent = this.options.sendProbe(identity)
    } catch {
      sent = false
    }
    if (!sent) {
      this.terminateCurrent(identity)
      return
    }
    this.timer = this.setTimer(() => this.handleProbeTimeout(identity, sentAt), this.probeTimeoutMs)
  }

  private handleProbeTimeout(identity: RpcSessionIdentity, sentAt: number): void {
    this.timer = null
    if (this.identity !== identity) {
      return
    }
    const elapsedMs = this.now() - sentAt
    if (elapsedMs < 0 || elapsedMs > this.probeTimeoutMs * 1.5) {
      console.log('[net] activity-probe unfair window skipped', {
        transport: this.options.transport,
        elapsedMs,
        timeoutMs: this.probeTimeoutMs
      })
      this.startProbe(identity)
      return
    }
    this.missedProbes += 1
    if (this.missedProbes >= this.missedProbeLimit) {
      this.terminateCurrent(identity)
      return
    }
    console.log('[net] activity-probe timeout tolerated', {
      transport: this.options.transport,
      missedProbes: this.missedProbes,
      missedProbeLimit: this.missedProbeLimit
    })
    this.startProbe(identity)
  }

  private terminateCurrent(identity: RpcSessionIdentity): void {
    if (this.identity !== identity) {
      return
    }
    this.clearActiveTimer()
    this.identity = null
    this.probing = false
    console.log('[net] activity-probe TIMEOUT — forcing reconnect', {
      transport: this.options.transport,
      missedProbes: this.missedProbes,
      missedProbeLimit: this.missedProbeLimit
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
