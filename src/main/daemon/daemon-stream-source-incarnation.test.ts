import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import { createNdjsonParser } from './ndjson'
import {
  backgroundSessionDropCapChars,
  dropOldestQueuedForSession,
  type PendingStreamDataBatch
} from './daemon-stream-keep-tail-drop'
import { appendDaemonStreamData } from './daemon-stream-data-entry'
import type { DaemonEvent } from './types'

function createBatch(): PendingStreamDataBatch {
  return {
    timer: null,
    queue: [],
    queuedChars: 0,
    queuedCharsBySession: new Map(),
    droppableQueuedSessionIds: new Set()
  }
}

function createBatcher(
  maxLineBytes = 1024,
  options: ConstructorParameters<typeof DaemonStreamDataBatcher>[1] = {}
) {
  vi.useFakeTimers()
  const socket = { destroyed: false, writableLength: 0, write: vi.fn() }
  const batcher = new DaemonStreamDataBatcher(
    () => ({ streamSocket: socket as unknown as Socket }),
    { maxLineBytes, ...options }
  )
  const events = (): DaemonEvent[] => socket.write.mock.calls.map(([line]) => JSON.parse(line))
  return { batcher, socket, events }
}

afterEach(() => vi.useRealTimers())

describe('daemon stream source incarnation', () => {
  it('coalesces same-source bytes, but separates queued generations and unknown legacy spans under one ID', () => {
    const { batcher, events } = createBatcher()
    for (const [data, incarnationId] of [
      ['old', 'old'],
      ['new', 'new'],
      ['er', 'new'],
      ['legacy', undefined],
      ['tail', undefined],
      ['late', 'old']
    ]) {
      batcher.enqueue('c', 's', data!, { incarnationId })
    }
    batcher.flush('c')
    expect(events().map((event) => event.payload)).toEqual([
      { data: 'old', incarnationId: 'old' },
      { data: 'newer', incarnationId: 'new' },
      { data: 'legacytail' },
      { data: 'late', incarnationId: 'old' }
    ])
  })

  it('preserves provenance and raw sequence ends across NDJSON fragments and held bulk remainders', () => {
    const { batcher, socket, events } = createBatcher(300)
    const data = '😀\x1b]133;D;0\x07'.repeat(9000)
    batcher.enqueue('c', 's', data, { incarnationId: 'old', seq: data.length })
    batcher.enqueue('c', 's', 'new', { incarnationId: 'new', seq: 3 })
    socket.write.mockImplementation(() => {
      socket.writableLength = 256 * 1024
      return false
    })
    batcher.flush('c')
    expect(batcher.queuedCharsForClient('c')).toBeGreaterThan(0)
    socket.writableLength = 0
    socket.write.mockImplementation(() => true)
    batcher.flush('c')
    const received: DaemonEvent[] = []
    const parser = createNdjsonParser((event) => received.push(event as DaemonEvent))
    const decoder = new StringDecoder('utf8')
    for (const [line] of socket.write.mock.calls) {
      expect(Buffer.byteLength(line.trimEnd())).toBeLessThanOrEqual(300)
      const bytes = Buffer.from(line)
      for (let i = 0; i < bytes.length; i += 7) {
        parser.feed(decoder.write(bytes.subarray(i, i + 7)))
      }
    }
    expect(received).toEqual(events())
    const frames = received
      .filter((event) => event.event === 'data')
      .filter((event) => event.payload.data !== '')
    const old = frames.filter((event) => event.payload.incarnationId === 'old')
    expect(old.map((event) => event.payload.data).join('')).toBe(data)
    let seq = 0
    for (const event of old) {
      seq += event.payload.data.length
      expect(event.payload.seq).toBe(seq)
    }
    expect(frames.at(-1)?.payload).toMatchObject({ data: 'new', incarnationId: 'new', seq: 3 })
    expect(batcher.queuedCharsForClient('c')).toBe(0)
    batcher.clear()
  })

  it('keeps gap accounting and query salvage at each source position, including repeated thinning and late facts', () => {
    const batch = createBatch()
    const query = '\x1b[6n'
    appendDaemonStreamData(batch, 's', `${query}aaaa`, { incarnationId: 'old' })
    batch.queue.push({
      sessionId: 's',
      data: '',
      control: {
        type: 'event',
        event: 'transientFact',
        sessionId: 's',
        payload: { kind: 'bell', incarnationId: 'old' }
      }
    })
    appendDaemonStreamData(batch, 's', `${query}bbbb`, { incarnationId: 'new' })
    appendDaemonStreamData(batch, 's', 'legacy', {})
    const salvage = (data: string): string => (data.includes(query) ? query : '')
    dropOldestQueuedForSession(batch, 's', 2, salvage)
    expect(
      batch.queue.map(
        (entry) =>
          entry.control?.payload ?? {
            data: entry.data,
            sequenceChars: entry.sequenceChars,
            incarnationId: entry.incarnationId
          }
      )
    ).toEqual([
      { droppedChars: 8, sequenceChars: 8, incarnationId: 'old' },
      { data: query, sequenceChars: 0, incarnationId: 'old' },
      { kind: 'bell', incarnationId: 'old' },
      { droppedChars: 8, sequenceChars: 8, incarnationId: 'new' },
      { data: query, sequenceChars: 0, incarnationId: 'new' },
      { droppedChars: 4, sequenceChars: 4 },
      { data: 'cy', sequenceChars: undefined, incarnationId: undefined }
    ])
    dropOldestQueuedForSession(batch, 's', 2, salvage)
    const gaps = batch.queue.flatMap((entry) =>
      entry.control?.event === 'dataGap' ? [entry.control.payload] : []
    )
    expect(gaps.map((gap) => [gap.incarnationId, gap.sequenceChars])).toEqual([
      ['old', 8],
      ['new', 8],
      [undefined, 4]
    ])
    expect(
      batch.queue
        .filter((entry) => entry.sequenceChars === 0)
        .map((entry) => [entry.incarnationId, entry.data])
    ).toEqual([
      ['old', query],
      ['new', query]
    ])
    expect(batch.queuedChars).toBe(
      batch.queue.reduce((total, entry) => total + entry.data.length, 0)
    )
    expect(batch.queuedCharsBySession.get('s')).toBe(batch.queuedChars)
  })

  it.each([false, true])(
    'preserves zero-weight query salvage before subsequent same-source output (immediate=%s)',
    (flushImmediately) => {
      const query = '\x1b[6n'
      const { batcher, events } = createBatcher(1024, {
        isSessionDroppable: () => true,
        salvageDroppedData: () => query
      })
      batcher.enqueue('c', 's', query + 'a'.repeat(backgroundSessionDropCapChars(1)), {
        incarnationId: 'source',
        transformed: true,
        rawLength: 90,
        seq: 90
      })
      expect(batcher.queuedCharsForClient('c')).toBe(query.length)
      batcher.enqueue('c', 's', 'x', {
        incarnationId: 'source',
        rawLength: 1,
        seq: 91,
        flushImmediately
      })
      batcher.flush('c')
      const frames = events()
      expect(frames[0]).toMatchObject({
        event: 'dataGap',
        payload: { sequenceChars: 90, incarnationId: 'source' }
      })
      expect(
        frames.reduce((sum, event) => {
          if (event.event === 'dataGap') {
            return sum + (event.payload.sequenceChars ?? event.payload.droppedChars)
          }
          if (event.event === 'data') {
            return sum + (event.payload.sequenceChars ?? event.payload.data.length)
          }
          return sum
        }, 0)
      ).toBe(91)
      expect(
        frames.filter((event) => event.event === 'data').map((event) => event.payload)
      ).toEqual([
        expect.objectContaining({ data: query, sequenceChars: 0, incarnationId: 'source' }),
        expect.objectContaining({ data: 'x', seq: 91, incarnationId: 'source' })
      ])
      expect(batcher.queuedCharsForClient('c')).toBe(0)
      batcher.clear()
    }
  )

  it('bounds repeated same-generation gap/salvage storage and never splits a transformed raw span', () => {
    const batch = createBatch()
    for (let i = 0; i < 100; i++) {
      appendDaemonStreamData(batch, 's', '\x1b[6n'.repeat(2048), { incarnationId: 'same' })
      dropOldestQueuedForSession(batch, 's', 16, (data) => data)
      expect(batch.queuedChars).toBeLessThanOrEqual(4096 + 16)
      expect(batch.queue.length).toBeLessThanOrEqual(4)
    }
    const transformed = createBatch()
    appendDaemonStreamData(transformed, 's', 'echo', {
      incarnationId: 'source',
      transformed: true,
      rawLength: 90,
      seq: 90
    })
    dropOldestQueuedForSession(transformed, 's', 2, () => '')
    expect(transformed.queue[0].control?.payload).toEqual({
      incarnationId: 'source',
      droppedChars: 4,
      sequenceChars: 90
    })
  })
})
