import type { TerminalMultiplexStream } from './terminal-stream-types'

const ESTIMATE_WINDOW_MS = 10_000
// Rate is ACK-measured, so it covers client parse speed too; below ~32 Mbit/s a 2MB window queues >0.5s ahead of echo.
const PACED_LINK_MAX_BYTES_PER_MS = 4 * 1024
export const PACED_WINDOW_MIN_BYTES = 64 * 1024
// LAN/local base RTT (network + parse + 4ms ACK flush) stays well under this; a busy renderer raises samples, not the minimum.
const PACED_LINK_MIN_BASE_RTT_MS = 40
const PACED_MIN_BACKLOGGED_SAMPLES = 16
// Without fresh window-limited samples the estimate may describe an old link state, so fall back to legacy windows.
const PACED_ESTIMATE_STALE_MS = 15_000
// Only a send with at most this much connection output ahead of it shows the path's own RTT.
const DRAINED_QUEUE_BYTES = 64 * 1024
// Paced RTT 1.5x beyond what our own queue can add means the path changed; hold legacy windows while the base re-learns.
const PACED_RTT_DIVERGENCE_FACTOR = 1.5
const PACED_DIVERGENCE_HOLD_MS = 2 * ESTIMATE_WINDOW_MS
// A probe that cannot drain (e.g. other streams keep the link busy) gives up and waits longer before retrying.
const PROBE_RTT_MAX_MS = 4_000
const PROBE_RTT_RETRY_AFTER_FAILURE_MS = 60_000
const MAX_SEND_RECORDS_PER_STREAM = 1024
const MAX_UNCONFIRMED_IMAGES = 64
const LEDGER_COMPACT_AFTER_RECORDS = 256

type SendRecord = {
  endOffset: number
  sendIndex: number
  sentAt: number
  delivered: number
  deliveredAt: number
  backlogged: boolean
  // Sent by a paced stream with its connection queue bounded by the paced window.
  paced: boolean
  drained: boolean
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

  reset(): void {
    this.current = null
    this.previous = null
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
  // Fed only by drained sends, so a backlog (ours or legacy's) never inflates the base.
  private readonly minRtt = new WindowedExtreme((a, b) => a < b)
  private readonly ackBurst = new WindowedExtreme((a, b) => a > b)
  private lastDrainedSampleAt = Number.NEGATIVE_INFINITY
  private pacedSmoothedRttMs: number | null = null
  private divergedAt = Number.NEGATIVE_INFINITY
  private probeRttStartedAt: number | null = null
  private nextProbeRttAt = Number.NEGATIVE_INFINITY
  private delivered = 0
  private deliveredAt = 0
  // Only a send that waited on the window measures the link; idle-trickle samples are lower bounds.
  private backloggedSamples = 0
  private lastBackloggedSampleAt = Number.NEGATIVE_INFINITY
  private sendIndex = 0
  // Recovery images bypass the window and are never acked, yet occupy the link ahead of later sends; an ack of a later send confirms them.
  private readonly unconfirmedImages: { bytes: number; afterSendIndex: number }[] = []
  private unconfirmedImageBytes = 0

  constructor(
    readonly now: () => number = () => performance.now(),
    readonly enabled: boolean = isAdaptiveAckWindowEnabled()
  ) {}

  noteSent(
    stream: TerminalMultiplexStream,
    bytes: number,
    options: { backlogged: boolean; paced: boolean; connectionInFlightBytes: number }
  ): void {
    const now = this.now()
    const queuedAhead = options.connectionInFlightBytes + this.unconfirmedImageBytes
    this.sendIndex += 1
    if (queuedAhead === 0) {
      // Idle gaps are not delivery time; restart the rate interval at this send.
      this.deliveredAt = now
    }
    let ledger = this.ledgers.get(stream)
    if (!ledger) {
      ledger = { records: [], head: 0, sentOffset: 0, ackedOffset: 0 }
      this.ledgers.set(stream, ledger)
    }
    ledger.sentOffset += bytes
    const drained = queuedAhead <= DRAINED_QUEUE_BYTES
    const paced = options.paced && this.unconfirmedImageBytes === 0
    const last = ledger.records.at(-1)
    if (last && ledger.records.length - ledger.head >= MAX_SEND_RECORDS_PER_STREAM) {
      // Merging keeps the older send time, which only overstates RTT (a larger, safer window).
      last.endOffset = ledger.sentOffset
      last.backlogged &&= options.backlogged
      last.paced &&= paced
      last.drained &&= drained
      return
    }
    ledger.records.push({
      endOffset: ledger.sentOffset,
      sendIndex: this.sendIndex,
      sentAt: now,
      delivered: this.delivered,
      deliveredAt: this.deliveredAt,
      backlogged: options.backlogged,
      paced,
      drained
    })
  }

  noteImageSent(bytes: number): void {
    const last = this.unconfirmedImages.at(-1)
    if (last && this.unconfirmedImages.length >= MAX_UNCONFIRMED_IMAGES) {
      // Merging under the newer index only delays confirmation, which keeps samples conservative.
      last.bytes += bytes
      last.afterSendIndex = this.sendIndex
    } else {
      this.unconfirmedImages.push({ bytes, afterSendIndex: this.sendIndex })
    }
    this.unconfirmedImageBytes += bytes
  }

  noteAcknowledged(stream: TerminalMultiplexStream, bytes: number): void {
    const ledger = this.ledgers.get(stream)
    if (!ledger || bytes <= 0) {
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
    if (ledger.head > LEDGER_COMPACT_AFTER_RECORDS && ledger.head * 2 > ledger.records.length) {
      ledger.records.splice(0, ledger.head)
      ledger.head = 0
    }
    this.ackBurst.add(bytes, now)
    if (!acked) {
      return
    }
    while (
      this.unconfirmedImages.length > 0 &&
      this.unconfirmedImages[0]!.afterSendIndex < acked.sendIndex
    ) {
      const image = this.unconfirmedImages.shift()!
      this.unconfirmedImageBytes -= image.bytes
      // The link carried the image, so the rate sample counts it.
      this.delivered += image.bytes
    }
    const rtt = Math.max(1, now - acked.sentAt)
    if (acked.drained) {
      this.minRtt.add(rtt, now)
      this.lastDrainedSampleAt = now
      if (
        acked.paced &&
        this.probeRttStartedAt !== null &&
        acked.sentAt >= this.probeRttStartedAt
      ) {
        this.probeRttStartedAt = null
        this.nextProbeRttAt = now + ESTIMATE_WINDOW_MS
      }
    }
    if (acked.paced) {
      this.pacedSmoothedRttMs =
        this.pacedSmoothedRttMs === null
          ? rtt
          : this.pacedSmoothedRttMs + (rtt - this.pacedSmoothedRttMs) / 8
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

  /** In-flight bytes a slow link needs to stay busy; null when unmeasured, stale, diverged, local, or fast. */
  steadyWindowBytes(): number | null {
    const rate = this.deliveryRate.value()
    const rtt = this.minRtt.value()
    const now = this.now()
    if (
      this.backloggedSamples < PACED_MIN_BACKLOGGED_SAMPLES ||
      this.isStale(now) ||
      now - this.divergedAt < PACED_DIVERGENCE_HOLD_MS ||
      rate === null ||
      rtt === null ||
      rtt < PACED_LINK_MIN_BASE_RTT_MS ||
      rate >= PACED_LINK_MAX_BYTES_PER_MS
    ) {
      return null
    }
    const burst = this.ackBurst.value() ?? 0
    // Our window queues at most about 2 RTT plus a burst ahead of a paced sample.
    if ((this.pacedSmoothedRttMs ?? 0) > PACED_RTT_DIVERGENCE_FACTOR * (3 * rtt + burst / rate)) {
      this.divergedAt = now
      this.pacedSmoothedRttMs = null
      this.probeRttStartedAt = null
      // The old base described the old path; wait for a drained sample of the new one.
      this.minRtt.reset()
      return null
    }
    // Twice the BDP lets a faster link show itself; the ACK burst covers client-side ack batching.
    return Math.max(PACED_WINDOW_MIN_BYTES, Math.ceil(2 * rate * rtt + burst))
  }

  /** The steady window, or 0 while probing: one chunk at a time so a drained sample can refresh the base RTT. */
  pacedWindowBytes(): number | null {
    const steady = this.steadyWindowBytes()
    if (steady === null) {
      this.probeRttStartedAt = null
      return null
    }
    const now = this.now()
    if (this.probeRttStartedAt !== null && now - this.probeRttStartedAt > PROBE_RTT_MAX_MS) {
      this.probeRttStartedAt = null
      this.nextProbeRttAt = now + PROBE_RTT_RETRY_AFTER_FAILURE_MS
    }
    if (
      this.probeRttStartedAt === null &&
      now >= this.nextProbeRttAt &&
      now - this.lastDrainedSampleAt > ESTIMATE_WINDOW_MS
    ) {
      this.probeRttStartedAt = now
    }
    return this.probeRttStartedAt === null ? steady : 0
  }

  private isStale(now: number): boolean {
    return now - this.lastBackloggedSampleAt > PACED_ESTIMATE_STALE_MS
  }
}
