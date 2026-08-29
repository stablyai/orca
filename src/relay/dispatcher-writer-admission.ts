export type DispatcherWriterLane =
  | 'liveness'
  | 'control'
  | 'legacy-response'
  | 'interactive'
  | 'ordinary'
  | 'fixed-bulk'
  | 'bulk'

export type DispatcherWriterSettlement = { ok: true } | { ok: false; error: Error }

export type DispatcherWriterEntry = {
  lane: DispatcherWriterLane
  encode: () => Buffer
  isStillAdmitted?: () => boolean
  estimatedBytes: number
  onSettled: (result: DispatcherWriterSettlement) => void
  settled: boolean
  // Why: control overflow closes the client by default; best-effort frames opt out of that instead.
  overflowIsNonFatal?: boolean
}

type AdmissionResult =
  | { accepted: true; replaced?: DispatcherWriterEntry }
  | { accepted: false; error?: Error }

export const DISPATCHER_CONTROL_QUEUE_MAX_FRAMES = 256
export const DISPATCHER_CONTROL_QUEUE_MAX_BYTES = 1024 * 1024
const LIVENESS_QUEUE_MAX_FRAMES = 2

export const DEFAULT_PRODUCER_QUEUE_MAX_BYTES = 2 * 1024 * 1024

export function onceDispatcherWriterSettlement(
  callback: (result: DispatcherWriterSettlement) => void
): (result: DispatcherWriterSettlement) => void {
  let settled = false
  return (result) => {
    if (settled) {
      return
    }
    settled = true
    callback(result)
  }
}

export function relayWriterControlReserve(highWaterMark: number): number {
  if (!Number.isFinite(highWaterMark)) {
    return 0
  }
  return Math.min(64 * 1024, Math.max(1024, Math.floor(highWaterMark / 4)))
}

const LANE_QUEUE_COMPACTION_HEAD_THRESHOLD = 64

class DispatcherWriterLaneQueue {
  private entries: (DispatcherWriterEntry | undefined)[] = []
  private head = 0

  get length(): number {
    return this.entries.length - this.head
  }

  push(entry: DispatcherWriterEntry): void {
    this.entries.push(entry)
  }

  peek(): DispatcherWriterEntry | undefined {
    return this.entries[this.head]
  }

  shift(): DispatcherWriterEntry | undefined {
    const entry = this.entries[this.head]
    if (!entry) {
      return undefined
    }
    this.entries[this.head] = undefined
    this.head++
    this.compact()
    return entry
  }

  pop(): DispatcherWriterEntry | undefined {
    if (this.length === 0) {
      return undefined
    }
    const entry = this.entries.pop()
    if (this.entries.length === this.head) {
      this.reset()
    }
    return entry
  }

  takeAll(): DispatcherWriterEntry[] {
    const queued: DispatcherWriterEntry[] = []
    for (let index = this.head; index < this.entries.length; index++) {
      const entry = this.entries[index]
      if (entry) {
        queued.push(entry)
      }
    }
    this.reset()
    return queued
  }

  private compact(): void {
    if (this.head === this.entries.length) {
      this.reset()
      return
    }
    if (this.head >= LANE_QUEUE_COMPACTION_HEAD_THRESHOLD && this.head * 2 >= this.entries.length) {
      this.entries = this.entries.slice(this.head)
      this.head = 0
    }
  }

  private reset(): void {
    this.entries.length = 0
    this.head = 0
  }
}

export class DispatcherWriterAdmission {
  private readonly queues: Record<DispatcherWriterLane, DispatcherWriterLaneQueue> = {
    liveness: new DispatcherWriterLaneQueue(),
    control: new DispatcherWriterLaneQueue(),
    'legacy-response': new DispatcherWriterLaneQueue(),
    interactive: new DispatcherWriterLaneQueue(),
    ordinary: new DispatcherWriterLaneQueue(),
    'fixed-bulk': new DispatcherWriterLaneQueue(),
    bulk: new DispatcherWriterLaneQueue()
  }
  private controlBytes = 0
  private controlFrames = 0
  private producerBytes = 0
  private livenessOutstanding = 0

  constructor(private readonly producerQueueMaxBytes: number) {}

  get retainedProducerBytes(): number {
    return this.producerBytes
  }

  canAdmitControl(bytes: number): boolean {
    return (
      this.controlFrames < DISPATCHER_CONTROL_QUEUE_MAX_FRAMES &&
      this.controlBytes + bytes <= DISPATCHER_CONTROL_QUEUE_MAX_BYTES
    )
  }

  get queuedEntries(): number {
    return Object.values(this.queues).reduce((total, queue) => total + queue.length, 0)
  }

  canAdmitProducer(bytes: number, producerFrameCapacity: number): boolean {
    return (
      bytes <= producerFrameCapacity && this.producerBytes + bytes <= this.producerQueueMaxBytes
    )
  }

  admit(entry: DispatcherWriterEntry, producerFrameCapacity: number): AdmissionResult {
    if (entry.lane === 'liveness') {
      return this.admitLiveness(entry)
    }
    if (entry.lane === 'control') {
      return this.admitControl(entry)
    }
    if (entry.lane === 'legacy-response') {
      if (this.producerBytes + entry.estimatedBytes > this.producerQueueMaxBytes) {
        return { accepted: false }
      }
      this.producerBytes += entry.estimatedBytes
      this.queues[entry.lane].push(entry)
      return { accepted: true }
    }
    if (entry.lane === 'fixed-bulk' && this.producerBytes > 0) {
      return { accepted: false }
    }
    if (!this.canAdmitProducer(entry.estimatedBytes, producerFrameCapacity)) {
      return { accepted: false }
    }
    this.producerBytes += entry.estimatedBytes
    this.queues[entry.lane].push(entry)
    return { accepted: true }
  }

  peek(lane: DispatcherWriterLane): DispatcherWriterEntry | undefined {
    return this.queues[lane].peek()
  }

  shift(lane: DispatcherWriterLane): DispatcherWriterEntry | undefined {
    return this.queues[lane].shift()
  }

  takeQueued(): DispatcherWriterEntry[] {
    return Object.values(this.queues).flatMap((queue) => queue.takeAll())
  }

  release(entry: DispatcherWriterEntry): void {
    if (entry.lane === 'control') {
      this.controlFrames--
      this.controlBytes -= entry.estimatedBytes
    } else if (entry.lane === 'liveness') {
      this.livenessOutstanding--
    } else {
      this.producerBytes -= entry.estimatedBytes
    }
  }

  private admitLiveness(entry: DispatcherWriterEntry): AdmissionResult {
    const queue = this.queues.liveness
    if (this.livenessOutstanding >= LIVENESS_QUEUE_MAX_FRAMES) {
      const replaced = queue.pop()
      if (!replaced) {
        return { accepted: false }
      }
      queue.push(entry)
      return { accepted: true, replaced }
    }
    this.livenessOutstanding++
    queue.push(entry)
    return { accepted: true }
  }

  private admitControl(entry: DispatcherWriterEntry): AdmissionResult {
    // Why: best-effort controls may fail soft without weakening protocol-critical admission.
    const overflowIsNonFatal = entry.overflowIsNonFatal === true
    if (!this.canAdmitControl(entry.estimatedBytes)) {
      if (overflowIsNonFatal) {
        return { accepted: false }
      }
      return {
        accepted: false,
        error: new Error('Relay control queue exceeded its bounded capacity')
      }
    }
    this.controlFrames++
    this.controlBytes += entry.estimatedBytes
    this.queues.control.push(entry)
    return { accepted: true }
  }
}
