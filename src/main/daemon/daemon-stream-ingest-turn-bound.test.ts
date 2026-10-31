import { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { attachStreamEventReader } from './daemon-client-ndjson-readers'
import { armDaemonSocketCloseHandlers } from './daemon-client-socket-connect'
import {
  encodeBinaryStreamDataFrame,
  type DaemonStreamFraming
} from './daemon-stream-binary-framing'
import {
  attachTurnBoundedSocketReader,
  STREAM_INGEST_TURN_BYTES
} from './daemon-stream-ingest-turn-bound'

const CHUNK_BYTES = STREAM_INGEST_TURN_BYTES / 2
const CHUNK_COUNT = 8

function bufferedSocket(): Socket {
  const socket = new Socket()
  for (let index = 0; index < CHUNK_COUNT; index++) {
    socket.push(Buffer.alloc(CHUNK_BYTES, index))
  }
  socket.push(null)
  return socket
}

const nextTick = (): Promise<void> => new Promise((resolve) => process.nextTick(resolve))

describe('attachTurnBoundedSocketReader', () => {
  it('reads one turn budget, yields, then delivers the rest in order before end', async () => {
    const socket = bufferedSocket()
    const seen: number[] = []
    socket.on('end', () => seen.push(-1))
    attachTurnBoundedSocketReader(socket, (chunk) => seen.push(chunk[0]), Buffer.alloc(0))

    await nextTick()
    expect(seen).toEqual([0, 1])
    expect(socket.isPaused()).toBe(true)

    await vi.waitFor(() => expect(seen).toContain(-1))
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, -1])
    socket.destroy()
  })

  it('consumes the hello remainder first and counts it toward the turn', async () => {
    const socket = bufferedSocket()
    const seen: number[] = []
    attachTurnBoundedSocketReader(
      socket,
      (chunk) => seen.push(chunk[0]),
      Buffer.alloc(STREAM_INGEST_TURN_BYTES, 0xff)
    )

    await nextTick()
    expect(seen).toEqual([0xff])
    expect(socket.isPaused()).toBe(true)

    await vi.waitFor(() => expect(seen).toHaveLength(CHUNK_COUNT + 1))
    expect(seen).toEqual([0xff, 0, 1, 2, 3, 4, 5, 6, 7])
    socket.destroy()
  })

  it('stays paused after detach so no bytes are read without a consumer', async () => {
    const socket = bufferedSocket()
    const seen: number[] = []
    const reader = attachTurnBoundedSocketReader(
      socket,
      (chunk) => seen.push(chunk[0]),
      Buffer.alloc(0)
    )
    await nextTick()
    reader.detach()

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(seen).toEqual([0, 1])
    expect(socket.isPaused()).toBe(true)
    expect(socket.readableLength).toBe((CHUNK_COUNT - 2) * CHUNK_BYTES)
    socket.destroy()
  })

  it('stops consuming when the socket errors while paused', async () => {
    const socket = bufferedSocket()
    const seen: number[] = []
    const errors: Error[] = []
    socket.on('error', (error) => errors.push(error))
    attachTurnBoundedSocketReader(socket, (chunk) => seen.push(chunk[0]), Buffer.alloc(0))
    await nextTick()
    expect(socket.isPaused()).toBe(true)

    socket.destroy(new Error('reset'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(seen).toEqual([0, 1])
    expect(errors.map((error) => error.message)).toEqual(['reset'])
  })

  it('handles a control close only after the stream bytes already read are consumed', async () => {
    const stream = bufferedSocket()
    const control = new Socket()
    const seen: number[] = []
    const reader = attachTurnBoundedSocketReader(
      stream,
      (chunk) => seen.push(chunk[0]),
      Buffer.alloc(0)
    )
    const onClose = vi.fn(() => seen.push(-2))
    armDaemonSocketCloseHandlers(control, stream, onClose, reader.drainBuffered)
    await nextTick()
    expect(stream.isPaused()).toBe(true)

    control.destroy()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(seen.slice(0, CHUNK_COUNT + 1)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, -2])
    stream.destroy()
  })
})

describe('attachStreamEventReader across ingest pauses', () => {
  const sessionData = (index: number): string =>
    `${String(index).padStart(5, '0')} ${'█'.repeat(997)} 🚀 \\x1b[0m\r\n`

  it.each(['ndjson', 'binary-v1'] as const)(
    'delivers a %s stream byte-exact when chunks split records across pauses',
    async (streamFraming: DaemonStreamFraming) => {
      const events = Array.from({ length: 400 }, (_, index) => sessionData(index))
      const wire = Buffer.concat(
        events.map((data) =>
          streamFraming === 'binary-v1'
            ? encodeBinaryStreamDataFrame('session', data)
            : Buffer.from(
                `${JSON.stringify({ type: 'event', event: 'data', sessionId: 'session', payload: { data } })}\n`
              )
        )
      )
      expect(wire.length).toBeGreaterThan(STREAM_INGEST_TURN_BYTES * 4)
      const socket = new Socket()
      // Use an odd chunk size to exercise split records and multi-byte characters.
      for (let offset = 0; offset < wire.length; offset += 7001) {
        socket.push(wire.subarray(offset, offset + 7001))
      }
      socket.push(null)
      const received: string[] = []
      let pauses = 0
      socket.on('pause', () => (pauses += 1))
      const ended = new Promise((resolve) => socket.on('end', resolve))
      attachStreamEventReader(socket, { streamFraming, remainder: Buffer.alloc(0) }, (event) => {
        if (event.event === 'data') {
          received.push(event.payload.data)
        }
      })

      await ended
      expect(pauses).toBeGreaterThanOrEqual(4)
      expect(received.join('')).toBe(events.join(''))
      socket.destroy()
    }
  )
})
