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

type TeardownReason = 'probe-unanswered' | 'silence-limit'

export type RelayControlLivenessOptions = {
  cellUrl: string
  ping: () => void
  send?: (frame: string) => void
  isLive: () => boolean
  terminate: () => void
  random?: () => number
}

export class RelayControlLiveness {
  private readonly random: () => number
  private probe: { timer: ReturnType<typeof setInterval>; misses: number } | null = null
  private silenceTimer: ReturnType<typeof setInterval> | null = null
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private keepaliveSentAt = 0
  private openedAt = 0
  private lastInboundAt = 0

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
  }

  noteInbound(): void {
    this.lastInboundAt = Date.now()
    this.clearProbe()
  }

  // Pong proves transport only; do not extend application liveness for a server-unindexed socket.
  notePong(): void {
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
      this.keepaliveSentAt = Date.now()
      this.options.send?.(RELAY_CLIENT_KEEPALIVE_FRAME)
    }
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
    this.clearProbe()
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

  // Name teardown causes locally: origin sees only 1006, hiding fleet-wide false-positive probes.
  private tearDown(reason: TeardownReason): void {
    this.stop()
    console.warn(`[relay] control torn down cell=${this.options.cellUrl} reason=${reason}`)
    this.options.terminate()
  }
}
