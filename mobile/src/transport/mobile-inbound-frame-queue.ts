import {
  processMobileInboundMemoryLedger,
  type MobileInboundMemoryLedger
} from './mobile-inbound-memory-ledger'

// Why: a valid 10 MiB image preview expands twice through nested base64 framing to ~36 MiB of JS text.
export const MOBILE_INBOUND_MAX_FRAME_BYTES = 64 * 1024 * 1024
// Why: two valid large previews may overlap, but a stalled consumer cannot retain a third.
export const MOBILE_INBOUND_MAX_BUFFERED_BYTES = 96 * 1024 * 1024
// Why: tiny-frame floods need a count bound independent of their serialized size.
export const MOBILE_INBOUND_MAX_BUFFERED_FRAMES = 64

type PendingFrame = {
  raw: unknown
  releaseMemory: () => void
  retainedBytes: number
  settle: () => void
}

export type MobileInboundFrameQueueEvidence = {
  retainedBytes: number
  retainedFrames: number
  storageSlots: number
}

export type MobileInboundFrameQueue = {
  enqueue(raw: unknown): Promise<void>
  dispose(): void
  evidence(): MobileInboundFrameQueueEvidence
}

const QUEUE_COMPACTION_HEAD_THRESHOLD = 64

export function createMobileInboundFrameQueue(options: {
  process: (raw: unknown) => Promise<void> | void
  onError: (error: Error) => void
  overflowMessage: string
  frameTooLargeMessage: string
  maxFrameBytes?: number
  maxBufferedBytes?: number
  maxBufferedFrames?: number
  memoryLedger?: MobileInboundMemoryLedger
}): MobileInboundFrameQueue {
  const maxFrameBytes = options.maxFrameBytes ?? MOBILE_INBOUND_MAX_FRAME_BYTES
  const maxBufferedBytes = options.maxBufferedBytes ?? MOBILE_INBOUND_MAX_BUFFERED_BYTES
  const maxBufferedFrames = options.maxBufferedFrames ?? MOBILE_INBOUND_MAX_BUFFERED_FRAMES
  const memoryLedger = options.memoryLedger ?? processMobileInboundMemoryLedger
  const queue: Array<PendingFrame | undefined> = []
  let queueHead = 0
  let retainedBytes = 0
  let retainedFrames = 0
  let draining = false
  let stopped = false

  const release = (frame: PendingFrame): void => {
    retainedBytes -= frame.retainedBytes
    retainedFrames -= 1
    frame.releaseMemory()
    frame.settle()
  }

  const dropQueued = (): void => {
    while (queueHead < queue.length) {
      release(queue[queueHead++]!)
    }
    queue.length = 0
    queueHead = 0
  }

  const fail = (error: Error): void => {
    if (stopped) {
      return
    }
    stopped = true
    dropQueued()
    options.onError(error)
  }

  const finishDrain = (): void => {
    if (queueHead === queue.length) {
      queue.length = 0
      queueHead = 0
    }
    draining = false
  }

  const continueDrain = (): void => {
    while (!stopped && queueHead < queue.length) {
      const frame = queue[queueHead++]!
      queue[queueHead - 1] = undefined
      if (queueHead >= QUEUE_COMPACTION_HEAD_THRESHOLD) {
        queue.splice(0, queueHead)
        queueHead = 0
      }
      let processing: Promise<void> | void
      try {
        processing = options.process(frame.raw)
      } catch (error) {
        release(frame)
        fail(error instanceof Error ? error : new Error(String(error)))
        finishDrain()
        return
      }
      if (processing) {
        void processing.then(
          () => {
            release(frame)
            if (stopped) {
              finishDrain()
              return
            }
            continueDrain()
          },
          (error: unknown) => {
            release(frame)
            fail(error instanceof Error ? error : new Error(String(error)))
            finishDrain()
          }
        )
        return
      }
      release(frame)
    }
    finishDrain()
  }

  const drain = (): void => {
    if (draining || stopped) {
      return
    }
    draining = true
    continueDrain()
  }

  return {
    enqueue(raw): Promise<void> {
      if (stopped) {
        return Promise.resolve()
      }
      const frameBytes = mobileInboundFrameRetainedBytes(raw, maxFrameBytes)
      if (frameBytes > maxFrameBytes) {
        fail(new Error(options.frameTooLargeMessage))
        return Promise.resolve()
      }
      if (retainedFrames >= maxBufferedFrames || retainedBytes + frameBytes > maxBufferedBytes) {
        fail(new Error(options.overflowMessage))
        return Promise.resolve()
      }
      const releaseMemory = memoryLedger.claim(frameBytes)
      if (!releaseMemory) {
        fail(new Error(options.overflowMessage))
        return Promise.resolve()
      }
      return new Promise((settle) => {
        queue.push({ raw, releaseMemory, retainedBytes: frameBytes, settle })
        retainedBytes += frameBytes
        retainedFrames += 1
        drain()
      })
    },
    dispose(): void {
      if (stopped) {
        return
      }
      stopped = true
      dropQueued()
    },
    evidence(): MobileInboundFrameQueueEvidence {
      return { retainedBytes, retainedFrames, storageSlots: queue.length }
    }
  }
}

export function assertMobileInboundFrameSize(
  raw: unknown,
  message: string,
  maxFrameBytes = MOBILE_INBOUND_MAX_FRAME_BYTES
): void {
  if (mobileInboundFrameRetainedBytes(raw, maxFrameBytes) > maxFrameBytes) {
    throw new Error(message)
  }
}

function mobileInboundFrameRetainedBytes(raw: unknown, unknownFrameBytes: number): number {
  if (typeof raw === 'string') {
    return raw.length * 2
  }
  if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
    return raw.byteLength
  }
  if (raw && typeof raw === 'object') {
    const size = numericProperty(raw, 'size') ?? numericProperty(raw, 'byteLength')
    if (size !== null) {
      return size
    }
  }
  // Why: unknown RN payload wrappers may materialize their bytes only during async conversion.
  return unknownFrameBytes
}

function numericProperty(value: object, key: 'size' | 'byteLength'): number | null {
  if (!(key in value)) {
    return null
  }
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
    ? candidate
    : null
}
