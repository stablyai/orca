import { describe, expect, it, vi } from 'vitest'
import {
  createBinaryStreamFrameReader,
  encodeBinaryStreamDataFrame
} from '../daemon-stream-binary-framing'
import { streamFramesFor } from '../daemon-stream-data-split'
import type { DaemonEvent } from '../../../protocol/daemon-stream-events'

function readAll(chunks: Buffer[], splitEvery?: number): { events: DaemonEvent[]; fatal: Error[] } {
  const events: DaemonEvent[] = []
  const fatal: Error[] = []
  const reader = createBinaryStreamFrameReader(
    (event) => events.push(event),
    (error) => fatal.push(error)
  )
  const joined = Buffer.concat(chunks)
  const step = splitEvery ?? joined.length
  for (let offset = 0; offset < joined.length; offset += step) {
    reader.feed(joined.subarray(offset, offset + step))
  }
  return { events, fatal }
}

describe('binary stream framing', () => {
  it('drops an unparsable record but keeps reading the frames after it', () => {
    const broken = Buffer.from([1, 0, 0, 0, 3, 0x7b, 0x7b, 0x7b])
    const next = encodeBinaryStreamDataFrame('session-1', 'after')
    const { events, fatal } = readAll([broken, next])
    expect(fatal).toEqual([])
    expect(events.map((event) => event.sessionId)).toEqual(['session-1'])
  })

  it('stops on a frame header it cannot trust', () => {
    const onEvent = vi.fn()
    const onFatal = vi.fn()
    const reader = createBinaryStreamFrameReader(onEvent, onFatal, 1024)
    reader.feed(Buffer.from([9, 0, 0, 0, 1, 0]))
    reader.feed(encodeBinaryStreamDataFrame('session-1', 'ignored'))
    expect(onFatal).toHaveBeenCalledTimes(1)
    expect(onEvent).not.toHaveBeenCalled()

    const oversized = vi.fn()
    createBinaryStreamFrameReader(onEvent, oversized, 16).feed(
      encodeBinaryStreamDataFrame('session-1', 'x'.repeat(64))
    )
    expect(oversized).toHaveBeenCalledTimes(1)
  })

  it('keeps every frame within the frame budget', () => {
    const frames: Buffer[] = []
    streamFramesFor('binary-v1').data(
      { write: (chunk) => frames.push(Buffer.from(chunk)) },
      'session-1',
      '\u{1F680}'.repeat(10_000),
      1024,
      20_000,
      99,
      false
    )
    expect(frames.length).toBeGreaterThan(1)
    for (const frame of frames) {
      expect(frame.readUInt32BE(1)).toBeLessThanOrEqual(1024)
    }
    const data = readAll(frames).events.map((event) =>
      event.event === 'data' ? event.payload.data : ''
    )
    expect(data.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true)
    expect(data.join('')).toBe('\u{1F680}'.repeat(10_000))
  })
})
