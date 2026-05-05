import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server, type Socket } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { DaemonClient } from './client'
import { encodeNdjson } from './ndjson'
import type { HelloMessage, DaemonRequest, DaemonEvent } from './types'

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'daemon-client-test-'))
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out')
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('DaemonClient', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: Server
  let client: DaemonClient

  beforeEach(() => {
    dir = createTestDir()
    socketPath = join(dir, 'test.sock')
    tokenPath = join(dir, 'test.token')
    writeFileSync(tokenPath, 'test-token-123')
  })

  afterEach(async () => {
    client?.disconnect()
    await new Promise<void>((resolve) => {
      if (server?.listening) {
        server.close(() => resolve())
      } else {
        resolve()
      }
    })
    rmSync(dir, { recursive: true, force: true })
  })

  function startMockDaemon(opts?: {
    onControlMessage?: (msg: unknown) => string | null
    onStreamHello?: (msg: HelloMessage) => void
    rejectVersion?: boolean
  }): Promise<void> {
    return new Promise((resolve) => {
      server = createServer((socket) => {
        let buffer = ''
        socket.on('data', (chunk) => {
          buffer += chunk.toString()
          let newlineIdx: number
          while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIdx)
            buffer = buffer.slice(newlineIdx + 1)
            if (!line) {
              continue
            }

            const msg = JSON.parse(line) as HelloMessage | DaemonRequest

            if (msg.type === 'hello') {
              const hello = msg as HelloMessage
              if (opts?.rejectVersion) {
                socket.write(encodeNdjson({ type: 'hello', ok: false, error: 'Version mismatch' }))
                return
              }
              socket.write(encodeNdjson({ type: 'hello', ok: true }))
              if (hello.role === 'stream') {
                opts?.onStreamHello?.(hello)
              }
            } else if (opts?.onControlMessage) {
              const response = opts.onControlMessage(msg)
              if (response) {
                socket.write(response)
              }
            }
          }
        })
      })

      server.listen(socketPath, () => resolve())
    })
  }

  describe('connect', () => {
    it('establishes connection with hello handshake', async () => {
      const hellos: HelloMessage[] = []
      await startMockDaemon({
        onStreamHello: (msg) => hellos.push(msg)
      })

      client = new DaemonClient({ socketPath, tokenPath })
      await client.ensureConnected()

      expect(client.isConnected()).toBe(true)
      // Both control and stream sockets should have sent hello
      await waitFor(() => hellos.length > 0)
    })

    it('rejects on version mismatch', async () => {
      await startMockDaemon({ rejectVersion: true })

      client = new DaemonClient({ socketPath, tokenPath })
      await expect(client.ensureConnected()).rejects.toThrow()
    })
  })

  describe('RPC', () => {
    it('sends request and receives response', async () => {
      await startMockDaemon({
        onControlMessage: (msg) => {
          const req = msg as { id: string; type: string }
          if (req.type === 'listSessions') {
            return encodeNdjson({
              id: req.id,
              ok: true,
              payload: { sessions: [] }
            })
          }
          return null
        }
      })

      client = new DaemonClient({ socketPath, tokenPath })
      await client.ensureConnected()

      const result = await client.request('listSessions', undefined)
      expect(result).toEqual({ sessions: [] })
    })

    it('rejects on error response', async () => {
      await startMockDaemon({
        onControlMessage: (msg) => {
          const req = msg as { id: string; type: string }
          return encodeNdjson({
            id: req.id,
            ok: false,
            error: 'Something went wrong'
          })
        }
      })

      client = new DaemonClient({ socketPath, tokenPath })
      await client.ensureConnected()

      await expect(client.request('listSessions', undefined)).rejects.toThrow(
        'Something went wrong'
      )
    })
  })

  describe('events', () => {
    it('receives stream events', async () => {
      let streamSocket: Socket | null = null
      await startMockDaemon({
        onStreamHello: () => {
          // We need to capture the stream socket to send events on it
        }
      })

      // Capture stream socket from server
      const origListener = server.listeners('connection')[0] as (s: Socket) => void
      server.removeAllListeners('connection')
      let socketCount = 0
      server.on('connection', (socket) => {
        socketCount++
        if (socketCount === 2) {
          streamSocket = socket
        }
        origListener(socket)
      })

      const events: DaemonEvent[] = []
      client = new DaemonClient({ socketPath, tokenPath })
      client.onEvent((event) => events.push(event as DaemonEvent))
      await client.ensureConnected()

      await waitFor(() => streamSocket !== null)

      // Send a data event on the stream socket
      const event: DaemonEvent = {
        type: 'event',
        event: 'data',
        sessionId: 'session-1',
        payload: { data: 'hello from daemon' }
      }
      streamSocket!.write(encodeNdjson(event))

      await waitFor(() => events.length > 0)
      expect(events[0]).toMatchObject({
        type: 'event',
        event: 'data',
        sessionId: 'session-1'
      })
    })
  })

  describe('disconnect', () => {
    it('emits disconnected when server destroys sockets', async () => {
      const serverSockets: Socket[] = []
      await startMockDaemon()
      server.on('connection', (socket) => serverSockets.push(socket))

      client = new DaemonClient({ socketPath, tokenPath })
      const disconnected = vi.fn()
      client.onDisconnected(disconnected)
      await client.ensureConnected()

      // Wait for both sockets to be tracked
      await waitFor(() => serverSockets.length >= 2)

      // Destroy all server-side sockets to simulate daemon crash
      for (const socket of serverSockets) {
        socket.destroy()
      }

      await waitFor(() => disconnected.mock.calls.length > 0, 3000)
      expect(client.isConnected()).toBe(false)
    })

    it('disconnect() can be called safely when not connected', () => {
      client = new DaemonClient({ socketPath, tokenPath })
      expect(() => client.disconnect()).not.toThrow()
    })
  })

  describe('notify (fire-and-forget)', () => {
    it('sends request with notify_ prefix without expecting response', async () => {
      const received: unknown[] = []
      await startMockDaemon({
        onControlMessage: (msg) => {
          received.push(msg)
          return null // no response
        }
      })

      client = new DaemonClient({ socketPath, tokenPath })
      await client.ensureConnected()

      client.notify('write', { sessionId: 'session-1', data: 'hello' })

      await waitFor(() => received.length > 0)
      const msg = received[0] as { id: string; type: string }
      expect(msg.id).toMatch(/^notify_/)
      expect(msg.type).toBe('write')
    })
  })
})
