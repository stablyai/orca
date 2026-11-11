import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { DaemonClient } from '../daemon-client'
import { encodeNdjson } from '../../../../../shared/main-process-ndjson-framer'
import { DaemonConnectionLostError } from '../../../protocol/daemon-errors'
import type { HelloMessage } from '../../../protocol/daemon-hello-protocol'
import type { DaemonRequest } from '../../../protocol/daemon-rpc-contract'
import type { DaemonEvent } from '../../../protocol/daemon-stream-events'
import { getDaemonSocketPath } from '../../../launch/daemon-spawner'

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
    rejectVersion?: boolean
    suppressHelloResponse?: boolean
    omitHelloIdentity?: boolean
    helloIdentity?: (role: 'control' | 'stream') => {
      pid: number
      startedAtMs: number
      launchNonce: string
      entryPath?: string
      appVersion?: string
      spawnerExecPath?: string
    }
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
              socket.write(
                encodeNdjson({
                  type: 'hello',
                  ok: true,
                  ...(!opts?.omitHelloIdentity
                    ? {
                        daemonIdentity: opts?.helloIdentity
                          ? opts.helloIdentity(hello.role)
                          : { pid: 123, startedAtMs: 456, launchNonce: 'default-launch' }
                      }
                    : {})
                })
              )
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
    it('rejects a v24 daemon that omits endpoint identity', async () => {
      await startMockDaemon({ omitHelloIdentity: true })
      client = new DaemonClient({ socketPath, tokenPath })

      await expect(client.ensureConnected()).rejects.toThrow('Invalid daemon identity')
    })

    it('allows a legacy v23 daemon to omit endpoint identity', async () => {
      await startMockDaemon({ omitHelloIdentity: true })
      client = new DaemonClient({ socketPath, tokenPath, protocolVersion: 23 })

      await expect(client.ensureConnected()).resolves.toBeUndefined()
      expect(client.getDaemonIdentity()).toBeNull()
    })

    it('rejects when control and stream sockets report different daemon identities', async () => {
      await startMockDaemon({
        helloIdentity: (role) => ({
          pid: role === 'control' ? 123 : 124,
          startedAtMs: 456,
          launchNonce: 'launch-a'
        })
      })

      client = new DaemonClient({ socketPath, tokenPath })

      await expect(client.ensureConnected()).rejects.toThrow(
        'Daemon identity changed during connection'
      )
      expect(client.getDaemonIdentity()).toBeNull()
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

    it('bounds a waiter on an existing connection attempt and prevents socket resurrection', async () => {
      let resolveHello: () => void = () => {}
      const helloReceived = new Promise<void>((resolve) => {
        resolveHello = resolve
      })
      await startMockDaemon({
        suppressHelloResponse: true,
        onHello: resolveHello
      })
      client = new DaemonClient({ socketPath, tokenPath })
      const ownerAttempt = client.ensureConnected().catch((error: Error) => error)
      await helloReceived

      await expect(client.ensureConnectedWithin(25)).rejects.toThrow(
        'Connection attempt wait timed out'
      )
      client.disconnect()
      await expect(ownerAttempt).resolves.toBeInstanceOf(Error)
      await new Promise((resolve) => setTimeout(resolve, 25))

      const disconnected = client as unknown as {
        controlSocket: Socket | null
        streamSocket: Socket | null
      }
      expect(client.isConnected()).toBe(false)
      expect(disconnected.controlSocket).toBeNull()
      expect(disconnected.streamSocket).toBeNull()
    })
  })

  describe('RPC', () => {
    it('survives a cancelCreateOrAttach the daemon refuses', async () => {
      // Old daemons reject cancellation; that refusal must not disconnect sibling sessions.
      const received: string[] = []
      await startMockDaemon({
        onControlMessage: (msg) => {
          const req = msg as { id: string; type: string }
          received.push(req.type)
          return req.type === 'cancelCreateOrAttach'
            ? encodeNdjson({
                id: req.id,
                ok: false,
                error: 'Unknown request type: cancelCreateOrAttach'
              })
            : null
        }
      })
      const disconnected = vi.fn()

      client = new DaemonClient({ socketPath, tokenPath })
      await client.ensureConnected()
      client.onDisconnected(disconnected)

      const sibling = client.request('listSessions', undefined)
      const siblingRejected = vi.fn()
      void sibling.catch(siblingRejected)
      const abort = new AbortController()
      const spawn = client.request('createOrAttach', { sessionId: 'aborted' }, 30_000, abort.signal)
      void spawn.catch(() => {})

      await waitFor(() => received.includes('createOrAttach') && received.includes('listSessions'))
      abort.abort()
      await waitFor(() => received.includes('cancelCreateOrAttach'))
      await new Promise((r) => setTimeout(r, 50))

      expect(client.isConnected()).toBe(true)
      expect(disconnected).not.toHaveBeenCalled()
      expect(siblingRejected).not.toHaveBeenCalled()
    })

    it('rejects in-flight requests as DaemonConnectionLostError when the socket dies', async () => {
      // Only transport errors may tear down the connection shared by sibling requests.
      const serverSockets: Socket[] = []
      await startMockDaemon({ onControlMessage: () => null })
      server.on('connection', (socket) => serverSockets.push(socket))

      client = new DaemonClient({ socketPath, tokenPath })
      await client.ensureConnected()
      const inFlight = client.request('listSessions', undefined)
      const rejected = expect(inFlight).rejects.toBeInstanceOf(DaemonConnectionLostError)

      await waitFor(() => serverSockets.length > 0)
      for (const socket of serverSockets) {
        socket.destroy()
      }

      await rejected
    })
  })

  describe('events', () => {
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

  describe('notify (fire-and-forget)', () => {
    it('reports an asynchronous socket write failure at settlement', async () => {
      await startMockDaemon()
      client = new DaemonClient({ socketPath, tokenPath })
      await client.ensureConnected()
      const internals = client as unknown as { controlSocket: Socket }
      vi.spyOn(internals.controlSocket, 'write').mockImplementation(((
        _data: string,
        callback: (error?: Error | null) => void
      ) => {
        callback(new Error('EPIPE'))
        return false
      }) as Socket['write'])

      await expect(
        client.notifyWithSettlement('write', { sessionId: 'session-1', data: 'hello' })
      ).resolves.toEqual({
        outcome: 'unverifiable',
        reason: 'transport_settlement_lost',
        bytesHandedToTransport: true
      })
      expect(client.isConnected()).toBe(false)
    })

    it('disconnects a daemon socket whose write settlement exceeds its deadline', async () => {
      await startMockDaemon()
      client = new DaemonClient({ socketPath, tokenPath })
      await client.ensureConnected()
      const internals = client as unknown as { controlSocket: Socket }
      vi.spyOn(internals.controlSocket, 'write').mockImplementation((() => true) as Socket['write'])
      vi.useFakeTimers()

      const pending = client.notifyWithSettlement(
        'write',
        { sessionId: 'session-1', data: 'hello' },
        5000
      )
      const settled = expect(pending).resolves.toEqual({
        outcome: 'unverifiable',
        reason: 'settlement_timeout',
        bytesHandedToTransport: true
      })
      await vi.advanceTimersByTimeAsync(5000)

      await settled
      expect(client.isConnected()).toBe(false)
    })
  })
})
