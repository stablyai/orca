import type { RelayControlRequestTimeout } from './relay-control-requests'
import { RELAY_RENEWAL_JITTER_RATIO } from './relay-renewal-jitter'

// STA-7672: a control request that times out has two indistinguishable causes —
// a loaded relay whose reply is late, or a half-open TCP socket that swallowed
// the send (common on Windows behind NAT/VPN or across sleep-resume, where the
// OS reports the write as succeeding). A close would have rejected as
// `relay_control_closed_<code>`, so a timeout proves the socket stayed open and
// never answered. An RFC 6455 ping settles which cause it was without spending
// an application opcode: any live peer must answer with a pong.

// The relay pings every 15s and closes a control after 75s of silence; mirror
// that bound so a dead or server-side-unindexed socket cannot stay "active".
const SILENCE_LIMIT_MS = 75_000
const SILENCE_CHECK_INTERVAL_MS = 15_000

// Three of these resolve a suspect socket in 24s, well inside the silence bound
// above — which on Windows let a user burn every pairing attempt before it fired.
const PROBE_INTERVAL_MS = 8_000

// One unanswered probe is UNKNOWN, not death: a cellular/VPN blackhole or a
// stalled TCP retransmit routinely swallows a lone pong (STA-3320). The run this
// requires also makes the window (24s) outlast the relay's own 15s ping, so a
// middlebox that swallows every pong still cannot force a reconnect loop — the
// cell's ping lands inside the window and clears the run. A teardown therefore
// means the pipe carried neither frame, three times over.
const PROBE_MISS_LIMIT = 3

type TeardownReason = 'probe-unanswered' | 'silence-limit'

export type RelayControlLivenessOptions = {
  cellUrl: string
  ping: () => void
  isLive: () => boolean
  terminate: () => void
  random?: () => number
}

/** Everything that decides whether a control socket is still reachable. */
export class RelayControlLiveness {
  private readonly random: () => number
  private probe: { timer: ReturnType<typeof setInterval>; misses: number } | null = null
  private silenceTimer: ReturnType<typeof setInterval> | null = null
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
        this.tearDown('silence-limit')
      }
    }, SILENCE_CHECK_INTERVAL_MS)
    this.silenceTimer.unref?.()
  }

  noteInbound(): void {
    this.lastInboundAt = Date.now()
    this.clearProbe()
  }

  // A pong proves the pipe and nothing more — it can come from a socket the
  // relay has already unindexed — so it clears a probe but never advances
  // `lastInboundAt`, whose job is to mirror the relay's own 75s bound.
  notePong(): void {
    this.clearProbe()
  }

  stop(): void {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer)
      this.silenceTimer = null
    }
    this.clearProbe()
  }

  /**
   * Probe only when nothing at all arrived since the send: then the relay's own
   * ping is overdue too, which is the half-open signature rather than a reply
   * running late under load. Otherwise this just records why the request failed.
   */
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
    // Logged rather than appended to the rejection, which is a classification
    // key; the pairing flow discards the rejection's text entirely.
    console.warn(`[relay] control request timed out ${diagnostics.join(' ')}`)
  }

  /** Starts a probe run if none is live; returns what to report in the log. */
  private armProbe(): string {
    if (this.probe) {
      return `probe=in-flight/${this.probe.misses}`
    }
    if (!this.sendProbe()) {
      return 'probe=send-failed'
    }
    // One jitter offset per run is enough to keep a cohort timing out against
    // the same slow cell off a shared boundary (see RELAY_RENEWAL_JITTER_RATIO).
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
      // A ping that throws on a live control is already the answer.
      this.tearDown('probe-unanswered')
      return false
    }
  }

  /** Any inbound frame — pong or application message — retires the probe run. */
  private clearProbe(): void {
    if (this.probe) {
      clearInterval(this.probe.timer)
      this.probe = null
    }
  }

  // A teardown lands on the origin as an ordinary 1006 close, so name the cause
  // here: without it a probe-driven reconnect is indistinguishable from any
  // other drop, and a fleet-wide false positive would be invisible.
  private tearDown(reason: TeardownReason): void {
    this.stop()
    console.warn(`[relay] control torn down cell=${this.options.cellUrl} reason=${reason}`)
    this.options.terminate()
  }
}
