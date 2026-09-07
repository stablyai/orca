import { describe, expect, it, vi } from 'vitest'
import {
  FrameDecoder,
  FrameDecoderContinuationError,
  FRAME_DECODER_MAX_RETAINED_BYTES,
  HEADER_LENGTH,
  MAX_MESSAGE_SIZE,
  MessageType,
  encodeFrame,
  type DecodedFrame
} from './relay-protocol'

function createScheduler(): {
  schedule: (callback: () => void) => number
  cancel: (handle: unknown) => void
  runNext: () => void
  pending: () => number
} {
  let nextHandle = 1
  const callbacks = new Map<number, () => void>()
  return {
    schedule: (callback) => {
      const handle = nextHandle++
      callbacks.set(handle, callback)
      return handle
    },
    cancel: (handle) => callbacks.delete(handle as number),
    runNext: () => {
      const entry = callbacks.entries().next().value as [number, () => void] | undefined
      if (!entry) {
        throw new Error('No decoder continuation scheduled')
      }
      callbacks.delete(entry[0])
      entry[1]()
    },
    pending: () => callbacks.size
  }
}

function frame(id: number, payload = `${id}`): Buffer {
  return encodeFrame(MessageType.Regular, id, 0, Buffer.from(payload))
}

describe('FrameDecoder bounded turns', () => {
  it('retains at most one maximum frame plus one MiB of partial input', () => {
    expect(FRAME_DECODER_MAX_RETAINED_BYTES).toBe(MAX_MESSAGE_SIZE + HEADER_LENGTH + 1024 * 1024)
    const maximumFrame = encodeFrame(MessageType.Regular, 1, 0, Buffer.alloc(MAX_MESSAGE_SIZE))
    const acceptedError = vi.fn()
    const accepted = new FrameDecoder(vi.fn(), acceptedError)

    accepted.feed(Buffer.concat([maximumFrame, Buffer.alloc(1024 * 1024)]))

    expect(acceptedError).not.toHaveBeenCalled()
    expect(accepted.drain()).toHaveLength(1024 * 1024)

    const excessError = vi.fn()
    const excess = new FrameDecoder(vi.fn(), excessError)
    excess.feed(Buffer.concat([maximumFrame, Buffer.alloc(1024 * 1024 + 1)]))

    expect(excessError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('retained-input') })
    )
    expect(excess.drain()).toHaveLength(0)
  })

  it('fails closed when one delivered chunk exceeds retained-input capacity', () => {
    const onError = vi.fn()
    const decoder = new FrameDecoder(vi.fn(), onError)

    decoder.feed(Buffer.alloc(FRAME_DECODER_MAX_RETAINED_BYTES + 1))

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('retained-input') })
    )
    expect(decoder.drain()).toHaveLength(0)
  })

  it('emits the first frame synchronously and preserves order through self-pause', () => {
    const scheduler = createScheduler()
    const seen: number[] = []
    let decoder: FrameDecoder
    const pause = vi.fn(() => decoder.feed(frame(4)))
    const resume = vi.fn()
    decoder = new FrameDecoder((decoded) => seen.push(decoded.id), undefined, {
      maxFramesPerTurn: 1,
      schedule: scheduler.schedule,
      cancelScheduled: scheduler.cancel,
      pause,
      resume
    })

    decoder.feed(Buffer.concat([frame(1), frame(2), frame(3)]))

    expect(seen).toEqual([1])
    expect(pause).toHaveBeenCalledTimes(1)
    expect(scheduler.pending()).toBe(1)

    scheduler.runNext()
    scheduler.runNext()
    scheduler.runNext()

    expect(seen).toEqual([1, 2, 3, 4])
    expect(pause).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(scheduler.pending()).toBe(0)
  })

  it('bounds decoded bytes and time independently from the frame count', () => {
    const byteScheduler = createScheduler()
    const byteSeen: number[] = []
    const first = frame(1, 'one')
    const second = frame(2, 'two')
    const byteDecoder = new FrameDecoder((decoded) => byteSeen.push(decoded.id), undefined, {
      maxFramesPerTurn: 64,
      maxBytesPerTurn: first.length,
      schedule: byteScheduler.schedule,
      cancelScheduled: byteScheduler.cancel
    })

    byteDecoder.feed(Buffer.concat([first, second]))
    expect(byteSeen).toEqual([1])
    byteScheduler.runNext()
    expect(byteSeen).toEqual([1, 2])

    const timeScheduler = createScheduler()
    const timeSeen: number[] = []
    let nowCalls = 0
    const timeDecoder = new FrameDecoder((decoded) => timeSeen.push(decoded.id), undefined, {
      maxFramesPerTurn: 64,
      maxBytesPerTurn: MAX_MESSAGE_SIZE + HEADER_LENGTH,
      maxTurnMs: 4,
      now: () => (nowCalls++ === 0 ? 0 : 5),
      schedule: timeScheduler.schedule,
      cancelScheduled: timeScheduler.cancel
    })

    timeDecoder.feed(Buffer.concat([frame(3), frame(4)]))
    expect(timeSeen).toEqual([3])
    timeScheduler.runNext()
    expect(timeSeen).toEqual([3, 4])
  })

  it('releases its pause epoch when continuation scheduling throws', () => {
    const pause = vi.fn()
    const resume = vi.fn()
    const decoder = new FrameDecoder(() => {}, undefined, {
      maxFramesPerTurn: 1,
      pause,
      resume,
      schedule: () => {
        throw new Error('scheduler unavailable')
      }
    })

    expect(() => decoder.feed(Buffer.concat([frame(1), frame(2)]))).toThrow('scheduler unavailable')
    expect(pause).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledTimes(1)
    decoder.reset()
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('contains a throwing continuation, resets residue, and reports one typed error', () => {
    const scheduler = createScheduler()
    const seen: number[] = []
    const onError = vi.fn()
    const pause = vi.fn()
    const resume = vi.fn()
    const decoder = new FrameDecoder(
      (decoded) => {
        if (decoded.id === 2) {
          throw new Error('frame owner failed')
        }
        seen.push(decoded.id)
      },
      onError,
      {
        maxFramesPerTurn: 1,
        schedule: scheduler.schedule,
        cancelScheduled: scheduler.cancel,
        pause,
        resume
      }
    )

    decoder.feed(Buffer.concat([frame(1), frame(2), frame(3)]))
    expect(() => scheduler.runNext()).not.toThrow()

    expect(seen).toEqual([1])
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.any(FrameDecoderContinuationError))
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      name: 'FrameDecoderContinuationError',
      cause: expect.objectContaining({ message: 'frame owner failed' })
    })
    expect(pause).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(scheduler.pending()).toBe(0)
    expect(decoder.drain()).toHaveLength(0)

    decoder.feed(frame(4))
    expect(seen).toEqual([1, 4])
  })

  it('keeps reads active for partial frames and incrementally discards oversized payloads', () => {
    const errors: Error[] = []
    const seen: DecodedFrame[] = []
    const pause = vi.fn()
    const decoder = new FrameDecoder(
      (decoded) => seen.push(decoded),
      (error) => errors.push(error),
      { pause }
    )
    const valid = frame(2, 'complete')

    decoder.feed(valid.subarray(0, HEADER_LENGTH + 2))
    expect(seen).toHaveLength(0)
    expect(pause).not.toHaveBeenCalled()
    decoder.feed(valid.subarray(HEADER_LENGTH + 2))
    expect(seen.map(({ id }) => id)).toEqual([2])

    const oversizedHeader = Buffer.alloc(HEADER_LENGTH)
    oversizedHeader[0] = MessageType.Regular
    oversizedHeader.writeUInt32BE(3, 1)
    oversizedHeader.writeUInt32BE(MAX_MESSAGE_SIZE + 1, 9)
    decoder.feed(Buffer.concat([oversizedHeader, Buffer.alloc(32)]))

    expect(errors).toHaveLength(1)
    expect(pause).not.toHaveBeenCalled()
    decoder.reset()
    decoder.feed(frame(4, 'after-reset'))
    expect(seen.map(({ id }) => id)).toEqual([2, 4])
  })

  it('drain and reset cancel continuation ownership without replaying residue', () => {
    const scheduler = createScheduler()
    const seen: number[] = []
    const resume = vi.fn()
    const cancel = vi.fn(scheduler.cancel)
    const decoder = new FrameDecoder((decoded) => seen.push(decoded.id), undefined, {
      maxFramesPerTurn: 1,
      schedule: scheduler.schedule,
      cancelScheduled: cancel,
      resume
    })
    const second = frame(2, 'residue')

    decoder.feed(Buffer.concat([frame(1), second]))
    const residue = decoder.drain()

    expect(seen).toEqual([1])
    expect(residue.equals(second)).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(scheduler.pending()).toBe(0)

    decoder.feed(Buffer.concat([frame(3), frame(4)]))
    decoder.reset()
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(scheduler.pending()).toBe(0)

    decoder.feed(frame(5))
    expect(seen).toEqual([1, 3, 5])
  })
})
