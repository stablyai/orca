import { once } from 'node:events'
import { createServer, Socket } from 'node:net'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import { createNdjsonParser } from './ndjson'
import { SessionProducerPause } from './session-producer-pause'

const MiB = 1024 * 1024

describe('daemon stream backpressure with a stalled Socket reader', () => {
  it.each([
    { chunkSize: 64 * 1024, hidden: false },
    { chunkSize: 1024, hidden: false },
    { chunkSize: 64 * 1024, hidden: true },
    { chunkSize: 1024, hidden: true }
  ])(
    'bounds $chunkSize-character writes (hidden=$hidden) and resumes',
    async ({ chunkSize, hidden }) => {
      const server = createServer()
      const writer = new Socket()
      let reader: Socket | undefined
      let paused = false
      let produced = 0
      let dropped = 0
      const received = new Map<string, number>()
      const producer = new SessionProducerPause({
        pause: () => {
          paused = true
        },
        resume: () => {
          paused = false
        }
      })
      const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: writer }), {
        isSessionDroppable: (sessionId) => hidden && sessionId === 'flood',
        onProducerBackpressureChanged: (sessionId, value) => {
          expect(sessionId).toBe('flood')
          producer.setStreamBackpressured(value)
        }
      })
      writer.on('drain', () => batcher.flush('client'))
      try {
        const accepted = once(server, 'connection')
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')
        const address = server.address()
        if (!address || typeof address === 'string') {
          throw new Error('Expected TCP address')
        }
        writer.connect(address.port, '127.0.0.1')
        await once(writer, 'connect')
        const [acceptedSocket] = await accepted
        if (!(acceptedSocket instanceof Socket)) {
          throw new Error('Expected accepted Socket')
        }
        reader = acceptedSocket
        const parser = createNdjsonParser(
          (event) => {
            if (
              !event ||
              typeof event !== 'object' ||
              !('sessionId' in event) ||
              typeof event.sessionId !== 'string' ||
              !('payload' in event)
            ) {
              return
            }
            const payload = event.payload
            if (
              payload &&
              typeof payload === 'object' &&
              'droppedChars' in payload &&
              typeof payload.droppedChars === 'number'
            ) {
              dropped += payload.droppedChars
            }
            if (
              !payload ||
              typeof payload !== 'object' ||
              !('data' in payload) ||
              typeof payload.data !== 'string'
            ) {
              return
            }
            received.set(
              event.sessionId,
              (received.get(event.sessionId) ?? 0) + payload.data.length
            )
          },
          () => {
            throw new Error('Invalid stream frame')
          }
        )
        reader.on('data', (data) => parser.feed(data.toString('utf8')))
        reader.pause()

        const chunk = 'x'.repeat(chunkSize)
        while (!paused && produced < 8 * MiB) {
          batcher.enqueue('client', 'flood', chunk, {
            flushImmediately: chunkSize <= 1024,
            flushMaxChars: 1024
          })
          batcher.flush('client')
          produced += chunkSize
          if (produced % MiB === 0) {
            await nextTurn()
          }
        }
        expect(paused).toBe(!hidden)
        expect(writer.writableLength + 2 * batcher.queuedCharsForClient('client')).toBeLessThan(
          5 * MiB
        )

        if (!hidden) {
          producer.pause()
          producer.resumeClient()
          expect(paused).toBe(true)
        }
        batcher.enqueue('client', 'typing', 'echo', { flushImmediately: true, flushMaxChars: 1024 })
        reader.resume()
        const startedAt = performance.now()
        while (paused || writer.writableLength || batcher.queuedCharsForClient('client')) {
          if (performance.now() - startedAt > 5_000) {
            throw new Error('Stream failed to drain')
          }
          await delay(5)
        }
        const ended = once(reader, 'end')
        writer.end()
        await ended
        expect((received.get('flood') ?? 0) + dropped).toBe(produced)
        expect(dropped > 0).toBe(hidden)
        expect(received.get('typing')).toBe(4)
        expect(paused).toBe(false)
      } finally {
        batcher.clear()
        producer.release({ resume: false })
        writer.destroy()
        reader?.destroy()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
  )
})
