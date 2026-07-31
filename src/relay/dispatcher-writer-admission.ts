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
  estimatedBytes: number
  onSettled: (result: DispatcherWriterSettlement) => void
  settled: boolean
}

type AdmissionResult =
  | { accepted: true; replaced?: DispatcherWriterEntry }
  | { accepted: false; error?: Error }

const CONTROL_QUEUE_MAX_FRAMES = 256
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

export class DispatcherWriterAdmission {
  private readonly queues: Record<DispatcherWriterLane, DispatcherWriterEntry[]> = {
    liveness: [],
    control: [],
    'legacy-response': [],
    interactive: [],
    ordinary: [],
    'fixed-bulk': [],
    bulk: []
  }
  private controlBytes = 0
  private controlFrames = 0
  private producerBytes = 0
  private livenessOutstanding = 0

  constructor(private readonly producerQueueMaxBytes: number) {}

  get retainedProducerBytes(): number {
    return this.producerBytes
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
    return this.queues[lane][0]
  }

  shift(lane: DispatcherWriterLane): DispatcherWriterEntry | undefined {
    return this.queues[lane].shift()
  }

  takeQueued(): DispatcherWriterEntry[] {
    return Object.values(this.queues).flatMap((queue) => queue.splice(0))
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
    if (
      this.controlFrames >= CONTROL_QUEUE_MAX_FRAMES ||
      this.controlBytes + entry.estimatedBytes > DISPATCHER_CONTROL_QUEUE_MAX_BYTES
    ) {
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
