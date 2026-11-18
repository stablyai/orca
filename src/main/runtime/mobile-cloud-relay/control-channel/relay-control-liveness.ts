import type { RelayControlRequestTimeout } from './relay-control-requests'
import { RELAY_RENEWAL_JITTER_RATIO } from '../session-lifecycle/relay-renewal-jitter'
import {
  RELAY_CLIENT_KEEPALIVE_FRAME,
  RelayKeepaliveAckMessageSchema,
  RelayKeepaliveOfferMessageSchema,
  RelayPingMessageSchema
} from './relay-control-protocol'

// STA-7672: request timeout may be relay load or half-open TCP; probe before inferring death.

// Mirror the relay's 15s application ping / 75s silence bounds.
const SILENCE_LIMIT_MS = 75_000
const SILENCE_CHECK_INTERVAL_MS = 15_000

// Three probes resolve suspects in 24s, before the silence bound.
const PROBE_INTERVAL_MS = 8_000

// STA-3320: one lost pong is inconclusive. Three misses span the relay's 15s application ping,
// so middleboxes dropping control frames cannot alone force reconnect loops.
const PROBE_MISS_LIMIT = 3

// The keepalive is answered at once (the edge auto-acks it). A reply 10s overdue only starts the
// probe above, so one lost frame still cannot tear the control down; it cuts stall detection ~17s.
const KEEPALIVE_ACK_OVERDUE_MS = 10_000

// Path-stall detector, armed only when the origin has an alternate path to resume on (client
// two-path failover). A failover resume is free while the edge still lists this control (it closes
// a control after 75s without a pong) and for its 30s orphan grace after, so detection must land
// well inside 75s. Protocol pings every 10s (±20%) are answered without waking the edge object.
// The stall is two unanswered pings in a row AND nothing at all inbound for 30s: the edge's own
// application ping comes every 25s, so a middlebox that drops protocol pongs cannot alone trip it.
// A path that goes dark is detected after 30-36s, leaving ~40s of the edge's 75s for the resume.
const STALL_PING_INTERVAL_MS = 10_000
const STALL_PING_JITTER_RATIO = 0.2
const STALL_PING_MISS_LIMIT = 2
const STALL_SILENCE_MIN_MS = 30_000

type TeardownReason = 'probe-unanswered' | 'silence-limit'

export type RelayControlLivenessOptions = {
  cellUrl: string
  ping: () => void
  send?: (frame: string) => void
  isLive: () => boolean
  terminate: () => void
  random?: () => number
  /** Arms the path-stall detector; called at most once, and the control is left as it is. */
  onStall?: () => void
}

export class RelayControlLiveness {
  private readonly random: () => number
  private probe: { timer: ReturnType<typeof setInterval>; misses: number } | null = null
  private silenceTimer: ReturnType<typeof setInterval> | null = null
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private keepaliveAckTimer: ReturnType<typeof setTimeout> | null = null
  private keepaliveSentAt = 0
  private openedAt = 0
  private lastInboundAt = 0
  private stall: {
    timer: ReturnType<typeof setTimeout> | null
    misses: number
    pingedAt: number
  } | null = null
  // Inbound frames and pongs: either proves the path, which is all the stall detector judges.
  private lastPathEvidenceAt = 0

  constructor(private readonly options: RelayControlLivenessOptions) {
    this.random = options.random ?? Math.random
  }

  start(): void {
    this.openedAt = Date.now()
    this.lastInboundAt = this.openedAt
    this.silenceTimer = setInterval(() => {
      if (Date.now() - this.lastInboundAt > SILENCE_LIMIT_MS) {
        // Our own keepalive timer was held back too (a throttled app), so the silence says nothing
        // about the link: send one now and judge on the next check.
        if (this.keepaliveTimer && Date.now() - this.keepaliveSentAt > SILENCE_LIMIT_MS) {
          this.sendKeepalive()
          return
        }
        this.tearDown('silence-limit')
      }
    }, SILENCE_CHECK_INTERVAL_MS)
    this.silenceTimer.unref?.()
    if (this.options.onStall) {
      this.lastPathEvidenceAt = this.openedAt
      this.stall = { timer: null, misses: 0, pingedAt: 0 }
      this.scheduleStallCheck(this.stallPingIntervalMs())
    }
  }

  noteInbound(): void {
    this.lastInboundAt = Date.now()
    this.lastPathEvidenceAt = this.lastInboundAt
    this.clearProbe()
  }

  // Pong proves transport only; do not extend application liveness for a server-unindexed socket.
  notePong(): void {
    this.lastPathEvidenceAt = Date.now()
    this.clearProbe()
  }

  /** Relay pings, the keepalive offer and its acks; the caller already counted them as inbound. */
  handleLivenessMessage(message: Record<string, unknown>): boolean {
    const ping = RelayPingMessageSchema.safeParse(message)
    if (ping.success) {
      this.options.send?.(JSON.stringify({ type: 'pong', t: ping.data.t }))
      return true
    }
    const offer = RelayKeepaliveOfferMessageSchema.safeParse(message)
    if (offer.success) {
      this.startKeepalive(offer.data.intervalMs)
      return true
    }
    return RelayKeepaliveAckMessageSchema.safeParse(message).success
  }

  // The relay offered the host-sent keepalive: its answer is an inbound frame, so it keeps the
  // silence bound met without relay pings. Relays that never offer keep pinging as before.
  startKeepalive(intervalMs: number): void {
    if (this.keepaliveTimer || !this.silenceTimer || !this.options.send) {
      return
    }
    this.keepaliveSentAt = Date.now()
    this.keepaliveTimer = setInterval(() => this.sendKeepalive(), intervalMs)
    this.keepaliveTimer.unref?.()
  }

  private sendKeepalive(): void {
    if (this.options.isLive()) {
      const sentAt = Date.now()
      this.keepaliveSentAt = sentAt
      this.options.send?.(RELAY_CLIENT_KEEPALIVE_FRAME)
      this.watchKeepaliveAck(sentAt)
    }
  }

  private watchKeepaliveAck(sentAt: number): void {
    if (this.keepaliveAckTimer) {
      return
    }
    this.keepaliveAckTimer = setTimeout(() => {
      this.keepaliveAckTimer = null
      if (this.lastInboundAt < sentAt && this.options.isLive()) {
        const sinceInboundMs = Date.now() - this.lastInboundAt
        console.warn(
          `[relay] control keepalive overdue cell=${this.options.cellUrl} sinceInboundMs=${sinceInboundMs} ${this.armProbe()}`
        )
      }
    }, KEEPALIVE_ACK_OVERDUE_MS)
    this.keepaliveAckTimer.unref?.()
  }

  stop(): void {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer)
      this.silenceTimer = null
    }
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
    if (this.keepaliveAckTimer) {
      clearTimeout(this.keepaliveAckTimer)
      this.keepaliveAckTimer = null
    }
    this.clearProbe()
    this.clearStall()
  }

  /** Probe only if no inbound frame arrived since send; otherwise a late reply can be ordinary relay load. */
  noteRequestTimeout(timeout: RelayControlRequestTimeout): void {
    const now = Date.now()
    const diagnostics = [
      `reqKind=${timeout.kind}`,
      `cell=${this.options.cellUrl}`,
      `socketAgeMs=${now - this.openedAt}`,
      `sinceInboundMs=${now - this.lastInboundAt}`
    ]
    if (this.options.isLive() && this.lastInboundAt <= timeout.sentAt) {
      diagnostics.push(this.armProbe())
    }
    // Keep rejection text a classification key; log diagnostics separately.
    console.warn(`[relay] control request timed out ${diagnostics.join(' ')}`)
  }

  private armProbe(): string {
    if (this.probe) {
      return `probe=in-flight/${this.probe.misses}`
    }
    if (!this.sendProbe()) {
      return 'probe=send-failed'
    }
    // Per-run jitter spreads cohorts probing the same slow cell.
    const spread = (this.random() * 2 - 1) * RELAY_RENEWAL_JITTER_RATIO
    const timer = setInterval(
      () => this.onProbeMissed(),
      Math.max(1, Math.floor(PROBE_INTERVAL_MS * (1 + spread)))
    )
    timer.unref?.()
    this.probe = { timer, misses: 0 }
    return 'probe=armed'
  }

  private onProbeMissed(): void {
    const probe = this.probe
    if (!probe) {
      return
    }
    probe.misses += 1
    if (probe.misses >= PROBE_MISS_LIMIT) {
      this.tearDown('probe-unanswered')
      return
    }
    this.sendProbe()
  }

  private sendProbe(): boolean {
    try {
      this.options.ping()
      return true
    } catch {
      this.tearDown('probe-unanswered')
      return false
    }
  }

  private clearProbe(): void {
    if (this.probe) {
      clearInterval(this.probe.timer)
      this.probe = null
    }
  }

  private stallPingIntervalMs(): number {
    const spread = (this.random() * 2 - 1) * STALL_PING_JITTER_RATIO
    return Math.max(1, Math.floor(STALL_PING_INTERVAL_MS * (1 + spread)))
  }

  private scheduleStallCheck(delayMs: number): void {
    if (!this.stall) {
      return
    }
    this.stall.timer = setTimeout(() => this.checkStall(), delayMs)
    this.stall.timer.unref?.()
  }

  private checkStall(): void {
    const stall = this.stall
    if (!stall) {
      return
    }
    stall.timer = null
    const now = Date.now()
    stall.misses =
      stall.pingedAt > 0 && this.lastPathEvidenceAt < stall.pingedAt ? stall.misses + 1 : 0
    const silentMs = now - this.lastPathEvidenceAt
    if (stall.misses >= STALL_PING_MISS_LIMIT && silentMs >= STALL_SILENCE_MIN_MS) {
      this.stall = null
      console.warn(
        `[relay] control path stalled cell=${this.options.cellUrl} silentMs=${silentMs} misses=${stall.misses}`
      )
      this.options.onStall?.()
      return
    }
    if (this.options.isLive()) {
      stall.pingedAt = now
      try {
        this.options.ping()
      } catch {
        // A ping that cannot be sent is a miss on the next check; the socket's close reports itself.
      }
    }
    const next = this.stallPingIntervalMs()
    // Two misses already: judge again as soon as the silence bound is met, not a full tick later.
    this.scheduleStallCheck(
      stall.misses >= STALL_PING_MISS_LIMIT
        ? Math.max(1, Math.min(next, STALL_SILENCE_MIN_MS - silentMs))
        : next
    )
  }

  private clearStall(): void {
    if (this.stall?.timer) {
      clearTimeout(this.stall.timer)
    }
    this.stall = null
  }

  // Name teardown causes locally: origin sees only 1006, hiding fleet-wide false-positive probes.
  private tearDown(reason: TeardownReason): void {
    this.stop()
    console.warn(`[relay] control torn down cell=${this.options.cellUrl} reason=${reason}`)
    this.options.terminate()
  }
}
