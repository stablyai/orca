import { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import {
  createBinaryStreamFrameReader,
  type DaemonStreamFraming
} from './daemon-stream-binary-framing'
import { createNdjsonParser } from './ndjson'
import type { DaemonEvent } from './types'

describe('daemon stream replacement framing', () => {
  it.each([
    ['ndjson', 'binary-v1'],
    ['binary-v1', 'ndjson']
  ] as const)('encodes held %s output for its replacement %s socket', (oldFraming, newFraming) => {
    vi.useFakeTimers()
    const oldSocket = new Socket()
    const newSocket = new Socket()
    vi.spyOn(oldSocket, 'writableLength', 'get').mockReturnValue(128 * 1024)
    vi.spyOn(oldSocket, 'write').mockReturnValue(false)
    const newWrites = vi.spyOn(newSocket, 'write').mockReturnValue(true)
    const client: { streamSocket: Socket; streamFraming: DaemonStreamFraming } = {
      streamSocket: oldSocket,
      streamFraming: oldFraming
    }
    const batcher = new DaemonStreamDataBatcher(() => client)
    const data = '\x1b[32m🚀\x1b[0m'.repeat(1000)
    const exit: DaemonEvent = {
      type: 'event',
      event: 'exit',
      sessionId: 'session',
      payload: { code: 0 }
    }
    try {
      batcher.enqueue('client', 'session', data, { seq: data.length })
      batcher.enqueueControlEvent('client', 'session', exit)
      batcher.flush('client')
      expect(batcher.queuedCharsForClient('client')).toBe(data.length)

      client.streamSocket = newSocket
      client.streamFraming = newFraming
      batcher.replaceStream('client')
      batcher.flush('client')

      const events: unknown[] = []
      const fatal: Error[] = []
      const binary = createBinaryStreamFrameReader(
        (event) => events.push(event),
        (error) => fatal.push(error)
      )
      const ndjson = createNdjsonParser(
        (event) => events.push(event),
        (error) => fatal.push(error)
      )
      for (const [chunk] of newWrites.mock.calls) {
        if (newFraming === 'binary-v1') {
          expect(Buffer.isBuffer(chunk)).toBe(true)
          binary.feed(Buffer.from(chunk))
        } else {
          expect(typeof chunk).toBe('string')
          ndjson.feed(String(chunk))
        }
      }
      expect(fatal).toEqual([])
      expect(events).toEqual([
        {
          type: 'event',
          event: 'data',
          sessionId: 'session',
          payload: { data, seq: data.length, rawLength: data.length, sequenceChars: data.length }
        },
        exit
      ])
      expect(batcher.queuedCharsForClient('client')).toBe(0)
    } finally {
      batcher.clear()
      oldSocket.destroy()
      newSocket.destroy()
      vi.useRealTimers()
    }
  })
})
