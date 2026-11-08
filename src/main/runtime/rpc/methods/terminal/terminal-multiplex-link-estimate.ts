import type { TerminalMultiplexStream } from './terminal-stream-types'
import { isAltBacklogSupersedeEnabled } from './terminal-multiplex-supersedable-frames'

const ESTIMATE_WINDOW_MS = 10_000
// Rate is ACK-measured, so it covers client parse speed too; below ~32 Mbit/s a 2MB window queues >0.5s ahead of echo.
const PACED_LINK_MAX_BYTES_PER_MS = 4 * 1024
const PACED_WINDOW_MIN_BYTES = 64 * 1024
// LAN/local base RTT (network + parse + 4ms ACK flush) stays well under this; a busy renderer raises samples, not the minimum.
const PACED_LINK_MIN_BASE_RTT_MS = 40
const PACED_MIN_BACKLOGGED_SAMPLES = 16
// Without fresh window-limited samples the estimate may describe an old link state, so fall back to legacy windows.
const PACED_ESTIMATE_STALE_MS = 15_000
// Paced RTT above twice what our own queue can add means the path changed; hold legacy windows while the base re-learns.
const PACED_RTT_DIVERGENCE_FACTOR = 2
const PACED_DIVERGENCE_HOLD_MS = 2 * ESTIMATE_WINDOW_MS
// Probes drain our queue so each min-RTT window sees the path itself, not a base inflated by our own backlog.
const PROBE_RTT_MAX_MS = 30_000
const MAX_SEND_RECORDS_PER_STREAM = 1024

type SendRecord = {
  endOffset: number
  sentAt: number
  delivered: number
  deliveredAt: number
  backlogged: boolean
  paced: boolean
}

type StreamSendLedger = {
  records: SendRecord[]
  head: number
  sentOffset: number
  ackedOffset: number
}

// Opt-in until soaked on real high-latency links.
export function isAdaptiveAckWindowEnabled(): boolean {
  return process.env.ORCA_TERMINAL_ADAPTIVE_ACK_WINDOW === '1'
}

/** Best sample over the last one-to-two windows of activity; idle time does not expire it. */
class WindowedExtreme {
  private current: number | null = null
  private previous: number | null = null
  private startedAt = 0

  constructor(private readonly isBetter: (a: number, b: number) => boolean) {}

  add(sample: number, now: number): void {
    if (this.current === null || now - this.startedAt >= ESTIMATE_WINDOW_MS) {
      this.previous = this.current
      this.current = sample
      this.startedAt = now
    } else if (this.isBetter(sample, this.current)) {
      this.current = sample
    }
  }

  value(): number | null {
    if (this.previous === null || this.current === null) {
      return this.current ?? this.previous
    }
    return this.isBetter(this.previous, this.current) ? this.previous : this.current
  }
}

/** BBR-style link estimate from existing output ACK timing, so pacing needs no protocol change. */
export class TerminalMultiplexLinkEstimate {
  private readonly ledgers = new WeakMap<TerminalMultiplexStream, StreamSendLedger>()
  private readonly deliveryRate = new WindowedExtreme((a, b) => a > b)
  private readonly minRtt = new WindowedExtreme((a, b) => a < b)
  private readonly ackBurst = new WindowedExtreme((a, b) => a > b)
  // Only samples sent under pacing, whose queue our window bounds, can show the path itself changed.
  private pacedSmoothedRttMs: number | null = null
  private divergedAt = Number.NEGATIVE_INFINITY
  private probeRttStartedAt: number | null = null
  private lastProbeRttAt = Number.NEGATIVE_INFINITY
  private delivered = 0
  private deliveredAt = 0
  // Only a send that waited on the window measures the link; idle-trickle samples are lower bounds.
  private backloggedSamples = 0
  private lastBackloggedSampleAt = Number.NEGATIVE_INFINITY

  constructor(
    readonly now: () => number = () => performance.now(),
    readonly enabled: boolean = isAdaptiveAckWindowEnabled(),
    // Read once per connection so per-frame and per-ACK paths skip process.env.
    readonly supersedesAltBacklog: boolean = enabled && isAltBacklogSupersedeEnabled()
  ) {}

  noteSent(
    stream: TerminalMultiplexStream,
    bytes: number,
    options: { backlogged: boolean; linkIdle: boolean; paced: boolean }
  ): void {
    if (!this.enabled) {
      return
    }
    const now = this.now()
    if (options.linkIdle) {
      // Idle gaps are not delivery time; restart the rate interval at this send.
      this.deliveredAt = now
    }
    let ledger = this.ledgers.get(stream)
    if (!ledger) {
      ledger = { records: [], head: 0, sentOffset: 0, ackedOffset: 0 }
      this.ledgers.set(stream, ledger)
    }
    ledger.sentOffset += bytes
    const last = ledger.records.at(-1)
    if (last && ledger.records.length - ledger.head >= MAX_SEND_RECORDS_PER_STREAM) {
      // Merging keeps the older send time, which only overstates RTT (a larger, safer window).
      last.endOffset = ledger.sentOffset
      last.backlogged &&= options.backlogged
      last.paced &&= options.paced
      return
    }
    ledger.records.push({
      endOffset: ledger.sentOffset,
      sentAt: now,
      delivered: this.delivered,
      deliveredAt: this.deliveredAt,
      backlogged: options.backlogged,
      paced: options.paced
    })
  }

  noteAcknowledged(stream: TerminalMultiplexStream, bytes: number): void {
    const ledger = this.ledgers.get(stream)
    if (!this.enabled || !ledger || bytes <= 0) {
      return
    }
    const now = this.now()
    ledger.ackedOffset += bytes
    this.delivered += bytes
    this.deliveredAt = now
    let acked: SendRecord | undefined
    while (
      ledger.head < ledger.records.length &&
      ledger.records[ledger.head]!.endOffset <= ledger.ackedOffset
    ) {
      acked = ledger.records[ledger.head]
      ledger.head += 1
    }
    if (ledger.head > 256 && ledger.head * 2 > ledger.records.length) {
      ledger.records.splice(0, ledger.head)
      ledger.head = 0
    }
    this.ackBurst.add(bytes, now)
    if (!acked) {
      return
    }
    const rtt = Math.max(1, now - acked.sentAt)
    this.minRtt.add(rtt, now)
    if (acked.paced) {
      this.pacedSmoothedRttMs =
        this.pacedSmoothedRttMs === null
          ? rtt
          : this.pacedSmoothedRttMs + (rtt - this.pacedSmoothedRttMs) / 8
    }
    if (this.probeRttStartedAt !== null && acked.sentAt >= this.probeRttStartedAt) {
      this.probeRttStartedAt = null
    }
    const interval = now - acked.deliveredAt
    if (interval < 1) {
      return
    }
    const rate = (this.delivered - acked.delivered) / interval
    if (acked.backlogged) {
      this.backloggedSamples = this.isStale(now) ? 1 : this.backloggedSamples + 1
      this.lastBackloggedSampleAt = now
      this.deliveryRate.add(rate, now)
    } else if (rate > (this.deliveryRate.value() ?? 0)) {
      this.deliveryRate.add(rate, now)
    }
  }

  /** In-flight bytes a slow link needs to stay busy; null when unmeasured, stale, diverged, disabled, local, or fast. */
  pacedWindowBytes(): number | null {
    const rate = this.deliveryRate.value()
    const rtt = this.minRtt.value()
    const now = this.now()
    if (
      !this.enabled ||
      this.backloggedSamples < PACED_MIN_BACKLOGGED_SAMPLES ||
      this.isStale(now) ||
      now - this.divergedAt < PACED_DIVERGENCE_HOLD_MS ||
      rate === null ||
      rtt === null ||
      rtt < PACED_LINK_MIN_BASE_RTT_MS ||
      rate >= PACED_LINK_MAX_BYTES_PER_MS
    ) {
      this.probeRttStartedAt = null
      return null
    }
    const burst = this.ackBurst.value() ?? 0
    // Our window queues at most about 2 RTT plus a burst ahead of a sample.
    const selfQueuedRtt = 3 * rtt + burst / rate
    if ((this.pacedSmoothedRttMs ?? 0) > PACED_RTT_DIVERGENCE_FACTOR * selfQueuedRtt) {
      this.divergedAt = now
      this.pacedSmoothedRttMs = null
      this.probeRttStartedAt = null
      return null
    }
    if (this.probeRttStartedAt !== null && now - this.probeRttStartedAt > PROBE_RTT_MAX_MS) {
      this.probeRttStartedAt = null
    }
    if (this.probeRttStartedAt === null && now - this.lastProbeRttAt > ESTIMATE_WINDOW_MS) {
      this.probeRttStartedAt = now
      this.lastProbeRttAt = now
    }
    if (this.probeRttStartedAt !== null) {
      // Zero admits one chunk only once nothing is in flight, so the probe's sample carries no queue of ours.
      return 0
    }
    // Twice the BDP lets a faster link show itself; the ACK burst covers client-side ack batching.
    return Math.max(PACED_WINDOW_MIN_BYTES, Math.ceil(2 * rate * rtt + burst))
  }

  private isStale(now: number): boolean {
    return now - this.lastBackloggedSampleAt > PACED_ESTIMATE_STALE_MS
  }

  deliveryBytesPerMs(): number | null {
    return this.deliveryRate.value()
  }
}
