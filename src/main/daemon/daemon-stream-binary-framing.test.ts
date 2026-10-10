import { describe, expect, it, vi } from 'vitest'
import {
  createBinaryStreamFrameReader,
  encodeBinaryStreamDataFrame,
  encodeBinaryStreamEventFrame
} from './daemon-stream-binary-framing'
import { createNdjsonParser } from './ndjson'
import { streamFramesFor, type StreamWriteChunk } from './daemon-stream-data-split'
import type { DaemonEvent } from './types'

function isDaemonEvent(record: unknown): record is DaemonEvent {
  return (
    typeof record === 'object' && record !== null && 'type' in record && record.type === 'event'
  )
}

const TERMINAL_TEXT = '\x1b[38;5;208m┌─ build ─┐\x1b[0m \u{1F680} ok\r\n"quoted" \\ tab\t'

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

function binaryEvents(write: (stream: { write(chunk: StreamWriteChunk): void }) => void) {
  const frames: Buffer[] = []
  write({ write: (chunk) => frames.push(Buffer.from(chunk)) })
  return readAll(frames).events
}

function ndjsonEvents(write: (stream: { write(chunk: StreamWriteChunk): void }) => void) {
  const events: DaemonEvent[] = []
  const parser = createNdjsonParser(
    (record) => {
      if (isDaemonEvent(record)) {
        events.push(record)
      }
    },
    () => {}
  )
  write({ write: (chunk) => parser.feed(String(chunk)) })
  return events
}

describe('binary stream framing', () => {
  it('serializes metadata once for each ordinary keystroke-sized write', () => {
    const stringify = vi.spyOn(JSON, 'stringify')
    const frames: StreamWriteChunk[] = []
    let calls: number
    try {
      for (let seq = 1; seq <= 100; seq++) {
        streamFramesFor('binary-v1').data(
          { write: (chunk) => frames.push(chunk) },
          'session',
          'x',
          4096,
          1,
          seq
        )
      }
      calls = stringify.mock.calls.length
    } finally {
      stringify.mockRestore()
    }
    expect(calls).toBe(100)
    expect(readAll(frames.map((frame) => Buffer.from(frame))).events).toHaveLength(100)
  })

  it('round-trips data and event frames across any socket chunking', () => {
    const frames = [
      encodeBinaryStreamDataFrame('session-1', TERMINAL_TEXT, { seq: 42, rawLength: 7 }),
      encodeBinaryStreamEventFrame({
        type: 'event',
        event: 'exit',
        sessionId: 'session-1',
        payload: { code: 0 }
      }),
      encodeBinaryStreamDataFrame('session-2', '')
    ]
    const expected = [
      {
        type: 'event',
        event: 'data',
        sessionId: 'session-1',
        payload: { seq: 42, rawLength: 7, data: TERMINAL_TEXT }
      },
      { type: 'event', event: 'exit', sessionId: 'session-1', payload: { code: 0 } },
      { type: 'event', event: 'data', sessionId: 'session-2', payload: { data: '' } }
    ]
    for (const splitEvery of [undefined, 1, 3, 7]) {
      expect(readAll(frames, splitEvery)).toEqual({ events: expected, fatal: [] })
    }
  })

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

  it.each([
    ['plain', undefined, undefined, false],
    ['seq and raw length', 12_000, 90_000, false],
    ['zero raw length', 0, 7, false],
    ['transformed', 3, 11, true]
  ] as const)(
    'follows the NDJSON per-chunk metadata rules for %s data',
    (_label, raw, seq, transformed) => {
      const data = TERMINAL_TEXT.repeat(400)
      const rawLength = raw ?? data.length
      const write =
        (framing: 'ndjson' | 'binary-v1') =>
        (stream: { write(chunk: StreamWriteChunk): void }): void =>
          streamFramesFor(framing).data(
            stream,
            'session-1',
            data,
            4096,
            rawLength,
            seq,
            transformed
          )
      // Chunk boundaries differ by design (byte vs JSON budgets); the metadata rules must not.
      const describeChunks = (events: DaemonEvent[]) => {
        let consumed = 0
        return events.map((event) => {
          if (event.event !== 'data') {
            throw new Error('expected data events only')
          }
          const { data: chunk, ...meta } = event.payload
          consumed += chunk.length
          return {
            meta,
            expected: transformed
              ? { seq, rawLength, sequenceChars: rawLength, transformed: true }
              : {
                  ...(seq === undefined ? {} : { seq: seq - (data.length - consumed) }),
                  ...(raw === undefined && seq === undefined
                    ? {}
                    : {
                        rawLength: raw === 0 ? 0 : chunk.length,
                        sequenceChars: raw === 0 ? 0 : chunk.length
                      })
                }
          }
        })
      }
      for (const events of [binaryEvents(write('binary-v1')), ndjsonEvents(write('ndjson'))]) {
        expect(
          events.map((event) => (event.event === 'data' ? event.payload.data : '')).join('')
        ).toBe(data)
        for (const { meta, expected } of describeChunks(events)) {
          expect(meta).toEqual(expected)
        }
      }
    }
  )

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
    // No chunk may split a surrogate pair.
    expect(data.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true)
    expect(data.join('')).toBe('\u{1F680}'.repeat(10_000))
  })
})
