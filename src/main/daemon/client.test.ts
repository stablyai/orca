import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { DaemonClient } from './client'
import { encodeNdjson } from './ndjson'
import type { HelloMessage, DaemonRequest, DaemonEvent } from './types'
import { getDaemonSocketPath } from './daemon-spawner'

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'daemon-client-test-'))
}

function splitInsideUtf8Sequence(payload: string, needle: string): [Buffer, Buffer] {
  const encoded = Buffer.from(payload, 'utf8')
  const encodedNeedle = Buffer.from(needle, 'utf8')
  const offset = encoded.indexOf(encodedNeedle)
  if (offset === -1 || encodedNeedle.length < 2) {
    throw new Error(`Unable to split payload inside ${needle}`)
  }
  return [encoded.subarray(0, offset + 1), encoded.subarray(offset + 1)]
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
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'test.token')
    writeFileSync(tokenPath, 'test-token-123')
  })

  afterEach(async () => {
    vi.useRealTimers()
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
    closeOnConnect?: boolean
    closeOnHello?: boolean
    onControlMessage?: (msg: unknown) => string | null
    onHello?: (msg: HelloMessage) => void
    onStreamHello?: (msg: HelloMessage) => void
    rejectVersion?: boolean
    suppressHelloResponse?: boolean
  }): Promise<void> {
    return new Promise((resolve) => {
      server = createServer((socket) => {
        if (opts?.closeOnConnect) {
          socket.destroy()
          return
        }

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
              opts?.onHello?.(hello)
              if (opts?.closeOnHello) {
                socket.destroy()
                return
              }
              if (opts?.suppressHelloResponse) {
                return
              }
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

    it('removes socket startup listeners after connecting', async () => {
      await startMockDaemon()

      client = new DaemonClient({ socketPath, tokenPath })
      await client.ensureConnected()

      const connectedClient = client as unknown as {
        controlSocket: Socket | null
        streamSocket: Socket | null
      }
      for (const socket of [connectedClient.controlSocket, connectedClient.streamSocket]) {
        expect(socket?.listenerCount('connect')).toBe(0)
        // One live error listener remains: the disconnect handler installed
        // after the daemon hello handshake succeeds.
        expect(socket?.listenerCount('error')).toBe(1)
      }
    })

    it('rejects on version mismatch', async () => {
      await startMockDaemon({ rejectVersion: true })

      client = new DaemonClient({ socketPath, tokenPath })
      await expect(client.ensureConnected()).rejects.toThrow()
    })

    it('times out when the daemon never answers hello', async () => {
      let resolveHello: () => void = () => {}
      const helloReceived = new Promise<void>((resolve) => {
        resolveHello = resolve
      })
      await startMockDaemon({
        suppressHelloResponse: true,
        onHello: resolveHello
      })

      vi.useFakeTimers()
      try {
        client = new DaemonClient({ socketPath, tokenPath })
        const outcomePromise = client
          .ensureConnected()
          .then(() => 'connected')
          .catch((error: Error) => error.message)

        await helloReceived
        await vi.advanceTimersByTimeAsync(5000)
        const outcome = await Promise.race([outcomePromise, Promise.resolve('pending')])

        expect(outcome).toBe('Hello response timed out')
      } finally {
        vi.useRealTimers()
      }
    })

    it('removes hello startup listeners after timeout', async () => {
      vi.useFakeTimers()

      client = new DaemonClient({ socketPath, tokenPath })
      const write = vi.fn(() => true)
      const destroy = vi.fn()
      const socket = new EventEmitter() as Socket
      socket.write = write as unknown as Socket['write']
      socket.destroy = destroy as unknown as Socket['destroy']
      const sendHello = (
        client as unknown as {
          sendHello(socket: Socket, token: string, role: 'control' | 'stream'): Promise<void>
        }
      ).sendHello.bind(client)

      const promise = sendHello(socket, 'test-token-123', 'control')
      const rejection = expect(promise).rejects.toThrow('Hello response timed out')
      await vi.advanceTimersByTimeAsync(5000)

      await rejection
      expect(write).toHaveBeenCalledOnce()
      expect(destroy).toHaveBeenCalledOnce()
      expect(socket.listenerCount('data')).toBe(0)
      expect(socket.listenerCount('error')).toBe(0)
      expect(socket.listenerCount('close')).toBe(0)
    })

    it('rejects when the daemon closes before hello completes', async () => {
      await startMockDaemon({ closeOnHello: true })

      client = new DaemonClient({ socketPath, tokenPath })
      await expect(client.ensureConnected()).rejects.toThrow(
        'Connection closed before hello response'
      )
    })

    it('rejects when the daemon closes immediately after connect', async () => {
      await startMockDaemon({ closeOnConnect: true })

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

    it('adds recovery hints to node-pty daemon diagnostics', async () => {
      await startMockDaemon({
        onControlMessage: (msg) => {
          const req = msg as { id: string; type: string }
          return encodeNdjson({
            id: req.id,
            ok: false,
            error:
              "node-pty: posix_spawn failed: ENOENT (errno 2, No such file or directory) - helper='/tmp/deleted/spawn-helper'"
          })
        }
      })

      client = new DaemonClient({ socketPath, tokenPath })
      await client.ensureConnected()

      await expect(client.request('listSessions', undefined)).rejects.toThrow(
        "Daemon's node-pty install is gone (worktree deleted?). Restart Orca. node-pty: posix_spawn failed: ENOENT"
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

    it('preserves UTF-8 stream events split inside multibyte characters', async () => {
      let streamSocket: Socket | null = null
      await startMockDaemon()

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

      const tableRow = '│OpenCode│🧩│┼────────┤'
      const event: DaemonEvent = {
        type: 'event',
        event: 'data',
        sessionId: 'session-1',
        payload: { data: tableRow }
      }
      const [first, second] = splitInsideUtf8Sequence(encodeNdjson(event), '🧩')
      streamSocket!.write(first)
      streamSocket!.write(second)

      await waitFor(() => events.length > 0)
      expect(events[0]).toMatchObject({
        type: 'event',
        event: 'data',
        sessionId: 'session-1',
        payload: { data: tableRow }
      })
      expect(JSON.stringify(events[0])).not.toContain('\ufffd')
    })
  })

  describe('disconnect', () => {
    it('removes socket listeners when disconnecting', async () => {
      await startMockDaemon()

      client = new DaemonClient({ socketPath, tokenPath })
      await client.ensureConnected()

      const connectedClient = client as unknown as {
        controlSocket: Socket | null
        streamSocket: Socket | null
      }
      const sockets = [connectedClient.controlSocket, connectedClient.streamSocket]
      for (const socket of sockets) {
        expect(socket?.listenerCount('data')).toBe(1)
        expect(socket?.listenerCount('close')).toBe(1)
        expect(socket?.listenerCount('error')).toBe(1)
      }

      client.disconnect()

      for (const socket of sockets) {
        expect(socket?.listenerCount('data')).toBe(0)
        expect(socket?.listenerCount('close')).toBe(0)
        expect(socket?.listenerCount('error')).toBe(0)
      }
    })

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
