import { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { sendDaemonHello } from './daemon-client-hello-handshake'
import {
  attachControlResponseReader,
  attachStreamEventReader
} from './daemon-client-ndjson-readers'
import {
  encodeBinaryStreamDataFrame,
  type DaemonStreamFraming
} from './daemon-stream-binary-framing'
import { encodeNdjson, NDJSON_MAX_LINE_BYTES } from './ndjson'
import { PROTOCOL_VERSION } from './types'

function bufferedSocket(chunks: Buffer[]): Socket {
  const socket = new Socket()
  vi.spyOn(socket, 'write').mockReturnValue(true)
  for (const chunk of chunks) {
    socket.push(chunk)
  }
  return socket
}

const IDENTITY = { pid: process.pid, startedAtMs: 1, launchNonce: 'reader-handoff' }
const DATA = '\x1b[32mhello\x1b[0m 🚀'

describe('daemon hello reader handoff', () => {
  it('rejects an oversized unterminated hello before retaining more input', async () => {
    const socket = bufferedSocket([Buffer.alloc(NDJSON_MAX_LINE_BYTES + 1, 0x78)])
    try {
      await expect(
        sendDaemonHello({
          socket,
          role: 'stream',
          token: 'token',
          clientId: 'client',
          protocolVersion: PROTOCOL_VERSION,
          timeoutMs: 1000
        })
      ).rejects.toThrow('Hello response exceeds maximum line size')
      expect(socket.destroyed).toBe(true)
    } finally {
      socket.destroy()
    }
  })

  it.each([
    ['ndjson', false],
    ['ndjson', true],
    ['binary-v1', false],
    ['binary-v1', true]
  ] as const)(
    'preserves fragmented %s output (tail buffered: %s)',
    async (streamFraming: DaemonStreamFraming, tailBuffered) => {
      const event = {
        type: 'event',
        event: 'data',
        sessionId: 'session',
        payload: { data: DATA }
      }
      const data =
        streamFraming === 'binary-v1'
          ? encodeBinaryStreamDataFrame('session', DATA)
          : Buffer.from(encodeNdjson(event))
      const socket = bufferedSocket([
        Buffer.from(
          encodeNdjson({ type: 'hello', ok: true, daemonIdentity: IDENTITY, streamFraming })
        ),
        data.subarray(0, 3),
        ...(tailBuffered ? [data.subarray(3)] : [])
      ])
      const onEvent = vi.fn()
      const errors: Error[] = []
      socket.on('error', (error) => errors.push(error))
      try {
        const outcome = await sendDaemonHello({
          socket,
          role: 'stream',
          token: 'token',
          clientId: 'client',
          protocolVersion: PROTOCOL_VERSION,
          timeoutMs: 1000
        })
        const off = attachStreamEventReader(socket, outcome, onEvent)
        await new Promise<void>((resolve) => setImmediate(resolve))
        if (!tailBuffered) {
          socket.push(data.subarray(3))
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
        expect(onEvent).toHaveBeenCalledExactlyOnceWith(event)
        expect(errors).toEqual([])
        expect(socket.destroyed).toBe(false)
        off()
      } finally {
        socket.destroy()
      }
    }
  )

  it.each([false, true])(
    'preserves control response bytes (same hello chunk: %s)',
    async (sameChunk) => {
      const response = { id: 'request', ok: true, payload: { value: DATA } }
      const helloBytes = Buffer.from(
        encodeNdjson({ type: 'hello', ok: true, daemonIdentity: IDENTITY })
      )
      const responseBytes = Buffer.from(encodeNdjson(response))
      const socket = bufferedSocket(
        sameChunk ? [Buffer.concat([helloBytes, responseBytes])] : [helloBytes, responseBytes]
      )
      const onResponse = vi.fn()
      try {
        const outcome = await sendDaemonHello({
          socket,
          role: 'control',
          token: 'token',
          clientId: 'client',
          protocolVersion: PROTOCOL_VERSION,
          timeoutMs: 1000
        })
        const off = attachControlResponseReader(socket, onResponse, outcome.remainder)
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(onResponse).toHaveBeenCalledExactlyOnceWith(response)
        off()
      } finally {
        socket.destroy()
      }
    }
  )
})
