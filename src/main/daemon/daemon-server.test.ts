import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { DaemonServer } from './daemon-server'
import { DaemonClient } from './client'
import { encodeNdjson } from './ndjson'
import { PROTOCOL_VERSION, type DaemonRequest } from './types'
import type { SubprocessHandle } from './session'
import { getDaemonPidPath, getDaemonSocketPath, serializeDaemonPidFile } from './daemon-spawner'

const confirmForegroundProcessMock = vi.fn(async () => 'droid')

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'daemon-server-test-'))
}

function createMockSubprocess(): SubprocessHandle & {
  _simulateData: (data: string) => void
  _simulateExit: (code: number) => void
} {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 55555,
    getForegroundProcess: vi.fn(() => null),
    confirmForegroundProcess: confirmForegroundProcessMock,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 5)),
    forceKill: vi.fn(() => onExitCb?.(137)),
    signal: vi.fn(),
    onData(cb) {
      onDataCb = cb
    },
    onExit(cb) {
      onExitCb = cb
    },
    dispose: vi.fn(),
    _simulateData(data: string) {
      onDataCb?.(data)
    },
    _simulateExit(code: number) {
      onExitCb?.(code)
    }
  }
}

type DaemonServerPrivate = {
  server: Server | null
  pendingPtySpawnPreparations: Map<string, Set<unknown>>
  host: {
    kill: (sessionId: string, opts?: { immediate?: boolean }) => void | Promise<void>
  }
  clients: Map<
    string,
    {
      clientId: string
      controlSocket: Socket
      streamSocket: Socket | null
      authenticatedPairEstablished: boolean
    }
  >
  routeRequest(clientId: string, request: DaemonRequest): Promise<unknown>
}

describe('DaemonServer', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let pidPath: string
  let server: DaemonServer
  let client: DaemonClient

  beforeEach(() => {
    confirmForegroundProcessMock.mockClear()
    dir = createTestDir()
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'test.token')
    pidPath = getDaemonPidPath(dir)
  })

  afterEach(async () => {
    client?.disconnect()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  async function startServer(launchNonce?: string): Promise<void> {
    server = new DaemonServer({
      socketPath,
      tokenPath,
      ...(launchNonce ? { pidPath, launchNonce } : {}),
      spawnSubprocess: () => createMockSubprocess()
    })
    await server.start()
  }

  async function connectClient(): Promise<DaemonClient> {
    client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    return client
  }

  async function connectRawHello(role: 'control' | 'stream', clientId: string): Promise<Socket> {
    const socket = connect(socketPath)
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    socket.write(
      encodeNdjson({
        type: 'hello',
        version: PROTOCOL_VERSION,
        token: readFileSync(tokenPath, 'utf-8').trim(),
        clientId,
        role
      })
    )
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        socket.off('data', onData)
        socket.off('error', onError)
      }
      const onData = (data: Buffer): void => {
        cleanup()
        const parsed = JSON.parse(data.toString().trim()) as { ok?: boolean; error?: string }
        if (parsed.ok) {
          resolve()
          return
        }
        reject(new Error(parsed.error ?? 'hello rejected'))
      }
      const onError = (error: Error): void => {
        cleanup()
        reject(error)
      }
      socket.on('data', onData)
      socket.on('error', onError)
    })
    return socket
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const startedAt = Date.now()
    while (!predicate() && Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(predicate()).toBe(true)
  }

  describe('startup', () => {
    it('creates token file and starts listening', async () => {
      await startServer()

      const token = readFileSync(tokenPath, 'utf-8')
      expect(token.length).toBeGreaterThan(0)
    })

    it('removes the startup error listener after listening', async () => {
      await startServer()

      const daemon = server as unknown as DaemonServerPrivate
      expect(daemon.server?.listenerCount('error')).toBe(0)
    })

    it('accepts client connections', async () => {
      await startServer()
      const c = await connectClient()
      expect(c.isConnected()).toBe(true)
    })
  })

  describe('RPC routing', () => {
    it('handles createOrAttach and returns result', async () => {
      await startServer()
      const c = await connectClient()

      const result = await c.request('createOrAttach', {
        sessionId: 'test-session',
        cols: 80,
        rows: 24
      })

      expect(result).toMatchObject({
        isNew: true,
        pid: 55555
      })
      await expect(
        c.request('closeStartupQueryAuthority', { sessionId: 'test-session' })
      ).resolves.toEqual({ appliedSeq: 0 })
    })

    it('keeps RPC responsive and creates one subprocess while spawn preparation is pending', async () => {
      let finishPreparation!: () => void
      const preparation = new Promise<void>((resolve) => {
        finishPreparation = resolve
      })
      const preparePtySpawn = vi.fn(() => preparation)
      const spawnSubprocess = vi.fn(() => createMockSubprocess())
      server = new DaemonServer({
        socketPath,
        tokenPath,
        preparePtySpawn,
        spawnSubprocess
      })
      await server.start()
      const c = await connectClient()

      const firstCreate = c.request<{ isNew: boolean }>('createOrAttach', {
        sessionId: 'prepared-session',
        cols: 80,
        rows: 24
      })
      const concurrentCreate = c.request<{ isNew: boolean }>('createOrAttach', {
        sessionId: 'prepared-session',
        cols: 80,
        rows: 24
      })
      await vi.waitFor(() => expect(preparePtySpawn).toHaveBeenCalledTimes(2))

      // The old spawnSync probe blocked this ping and all live PTY traffic.
      await expect(c.request('ping', undefined)).resolves.toEqual({ pong: true })
      expect(spawnSubprocess).not.toHaveBeenCalled()

      finishPreparation()
      const results = await Promise.all([firstCreate, concurrentCreate])
      expect(results.map((result) => result.isNew).sort()).toEqual([false, true])
      expect(spawnSubprocess).toHaveBeenCalledOnce()
    })

    it.each(['cancelCreateOrAttach', 'kill'] as const)(
      'prevents a pending subprocess after %s and permits later session reuse',
      async (requestType) => {
        let finishPreparation!: () => void
        const preparation = new Promise<void>((resolve) => {
          finishPreparation = resolve
        })
        const preparePtySpawn = vi.fn(() => preparation)
        const spawnSubprocess = vi.fn(() => createMockSubprocess())
        server = new DaemonServer({
          socketPath,
          tokenPath,
          preparePtySpawn,
          spawnSubprocess
        })
        await server.start()
        const c = await connectClient()

        const creates = [
          c.request('createOrAttach', {
            sessionId: 'canceled-preparation',
            cols: 80,
            rows: 24
          }),
          c.request('createOrAttach', {
            sessionId: 'canceled-preparation',
            cols: 80,
            rows: 24
          })
        ]
        const canceledCreates = Promise.all(
          creates.map((create) =>
            expect(create).rejects.toThrow('Attach canceled for session canceled-preparation')
          )
        )
        await vi.waitFor(() => expect(preparePtySpawn).toHaveBeenCalledTimes(2))

        const cancelRequest =
          requestType === 'kill'
            ? c.request('kill', { sessionId: 'canceled-preparation', immediate: true })
            : c.request('cancelCreateOrAttach', { sessionId: 'canceled-preparation' })
        await expect(cancelRequest).resolves.toEqual({})
        finishPreparation()
        await canceledCreates
        expect(spawnSubprocess).not.toHaveBeenCalled()

        await expect(
          c.request('createOrAttach', {
            sessionId: 'canceled-preparation',
            cols: 80,
            rows: 24
          })
        ).resolves.toMatchObject({ isNew: true })
        expect(spawnSubprocess).toHaveBeenCalledOnce()
      }
    )

    it('cancels pending subprocess preparation during daemon shutdown', async () => {
      let finishPreparation!: () => void
      const preparation = new Promise<void>((resolve) => {
        finishPreparation = resolve
      })
      const preparePtySpawn = vi.fn(() => preparation)
      const spawnSubprocess = vi.fn(() => createMockSubprocess())
      server = new DaemonServer({
        socketPath,
        tokenPath,
        preparePtySpawn,
        spawnSubprocess
      })
      await server.start()
      const c = await connectClient()

      const create = c.request('createOrAttach', {
        sessionId: 'shutdown-pending',
        cols: 80,
        rows: 24
      })
      const canceledCreate = expect(create).rejects.toThrow(
        'Attach canceled for session shutdown-pending'
      )
      await vi.waitFor(() => expect(preparePtySpawn).toHaveBeenCalledOnce())

      const shutdown = server.shutdown()
      finishPreparation()
      await canceledCreate
      await shutdown
      expect(spawnSubprocess).not.toHaveBeenCalled()
    })

    it('cancels a disconnecting client’s pending preparation to avoid an orphan PTY (F4)', async () => {
      let finishPreparation!: () => void
      const preparation = new Promise<void>((resolve) => {
        finishPreparation = resolve
      })
      const preparePtySpawn = vi.fn(() => preparation)
      const spawnSubprocess = vi.fn(() => createMockSubprocess())
      server = new DaemonServer({
        socketPath,
        tokenPath,
        preparePtySpawn,
        spawnSubprocess
      })
      await server.start()
      const c = await connectClient()

      // Hangs in preflight; the control-socket close must abort it before spawn.
      c.request('createOrAttach', {
        sessionId: 'disconnect-pending',
        cols: 80,
        rows: 24
      }).catch(() => {
        /* the disconnect rejects the in-flight request; that's expected */
      })
      await vi.waitFor(() => expect(preparePtySpawn).toHaveBeenCalledOnce())

      c.disconnect()
      // Wait for the server to process the close (and cancel the prep) before
      // releasing the preflight, else the resumed spawn races ahead of cancellation.
      await vi.waitFor(() =>
        expect((server as unknown as DaemonServerPrivate).clients.size).toBe(0)
      )
      finishPreparation()
      await vi.waitFor(() =>
        expect((server as unknown as DaemonServerPrivate).pendingPtySpawnPreparations.size).toBe(0)
      )
      expect(spawnSubprocess).not.toHaveBeenCalled()
    })

    it('kill with no pending preparation still surfaces SessionNotFoundError (F7)', async () => {
      await startServer()
      const c = await connectClient()

      // No preparation was canceled, so the host's not-found verdict must propagate
      // rather than be swallowed by the pending-spawn kill reconciliation.
      await expect(
        c.request('kill', { sessionId: 'never-created', immediate: true })
      ).rejects.toThrow('Session not found: never-created')
    })

    it('persists only an allowlisted launch identity across reattach', async () => {
      await startServer()
      const c = await connectClient()

      const first = await c.request('createOrAttach', {
        sessionId: 'agent-session',
        cols: 80,
        rows: 24,
        launchAgent: 'droid'
      })
      expect(first).toMatchObject({ isNew: true, launchAgent: 'droid' })

      const second = await c.request('createOrAttach', {
        sessionId: 'agent-session',
        cols: 80,
        rows: 24
      })
      expect(second).toMatchObject({ isNew: false, launchAgent: 'droid' })

      const unknown = await c.request('createOrAttach', {
        sessionId: 'unknown-agent-session',
        cols: 80,
        rows: 24,
        launchAgent: 'not-an-agent'
      } as never)
      expect(unknown).not.toHaveProperty('launchAgent')
    })

    it('handles listSessions', async () => {
      await startServer()
      const c = await connectClient()

      // Create a session first
      await c.request('createOrAttach', {
        sessionId: 'test-session',
        cols: 80,
        rows: 24
      })

      const result = await c.request<{ sessions: unknown[] }>('listSessions', undefined)
      expect(result.sessions).toHaveLength(1)
    })

    it('handles ping health checks', async () => {
      await startServer()
      const c = await connectClient()

      const result = await c.request<{ pong: boolean }>('ping', undefined)

      expect(result).toEqual({ pong: true })
    })

    it('replies with an error to unknown request types and keeps serving', async () => {
      await startServer()
      const c = await connectClient()

      // Why: downgraded clients can send request types this daemon does not
      // know. Reject gracefully instead of crashing the session server.
      await expect(c.request('definitelyUnknownRequest', undefined)).rejects.toThrow(
        'Unknown request type: definitelyUnknownRequest'
      )
      await expect(c.request<{ pong: boolean }>('ping', undefined)).resolves.toEqual({
        pong: true
      })
    })

    it('handles systemResolverHealth', async () => {
      await startServer()
      const c = await connectClient()

      const result = await c.request<{ health: unknown }>('systemResolverHealth', undefined)

      expect(['healthy', 'unhealthy', 'unknown']).toContain(result.health)
    })

    it('handles write (fire-and-forget)', async () => {
      await startServer()
      const c = await connectClient()

      await c.request('createOrAttach', {
        sessionId: 'test-session',
        cols: 80,
        rows: 24
      })

      // Should not throw
      c.notify('write', { sessionId: 'test-session', data: 'ls\n' })

      // Give the server time to process
      await new Promise((r) => setTimeout(r, 50))
    })

    it('handles resize', async () => {
      await startServer()
      const c = await connectClient()

      await c.request('createOrAttach', {
        sessionId: 'test-session',
        cols: 80,
        rows: 24
      })

      const result = await c.request('resize', {
        sessionId: 'test-session',
        cols: 120,
        rows: 40
      })

      expect(result).toBeDefined()
    })

    it('does not acknowledge kill until asynchronous teardown completes', async () => {
      await startServer()
      const daemon = server as unknown as DaemonServerPrivate
      let finishKill!: () => void
      const teardown = new Promise<void>((resolve) => {
        finishKill = resolve
      })
      const kill = vi.spyOn(daemon.host, 'kill').mockReturnValue(teardown)

      let acknowledged = false
      const routed = daemon
        .routeRequest('client-1', {
          id: 'kill-1',
          type: 'kill',
          payload: { sessionId: 'agent-session', immediate: true }
        })
        .then((result) => {
          acknowledged = true
          return result
        })

      await Promise.resolve()
      expect(kill).toHaveBeenCalledWith('agent-session', { immediate: true })
      expect(acknowledged).toBe(false)

      finishKill()
      await expect(routed).resolves.toEqual({})
      expect(acknowledged).toBe(true)
    })

    it('handles getCwd', async () => {
      await startServer()
      const c = await connectClient()

      await c.request('createOrAttach', {
        sessionId: 'test-session',
        cols: 80,
        rows: 24
      })

      const result = await c.request<{ cwd: string | null }>('getCwd', {
        sessionId: 'test-session'
      })

      // Mock subprocess doesn't emit OSC-7. The terminal-host fallback then
      // calls resolveProcessCwd(55555); on CI that pid is almost always dead
      // so the result is null, but we accept string too — a recycled pid that
      // happens to match would legitimately return a path and we don't want
      // this test to flake on whatever happens to be running on the host.
      expect(result.cwd === null || typeof result.cwd === 'string').toBe(true)
    })

    it('awaits fresh foreground confirmation', async () => {
      await startServer()
      const c = await connectClient()
      await c.request('createOrAttach', { sessionId: 'test-session', cols: 80, rows: 24 })

      await expect(
        c.request<{ foregroundProcess: string | null }>('confirmForegroundProcess', {
          sessionId: 'test-session'
        })
      ).resolves.toEqual({ foregroundProcess: 'droid' })
      expect(confirmForegroundProcessMock).toHaveBeenCalledTimes(1)
    })

    it('returns error for unknown session operations', async () => {
      await startServer()
      const c = await connectClient()

      await expect(c.request('write', { sessionId: 'nonexistent', data: 'hi' })).rejects.toThrow(
        'Session not found'
      )
    })

    it('emits exit when a fire-and-forget write targets a missing session', async () => {
      await startServer()
      const c = await connectClient()

      const exitEvent = new Promise<unknown>((resolve) => {
        c.onEvent((event) => resolve(event))
      })

      c.notify('write', { sessionId: 'missing-session', data: 'hi' })

      await expect(exitEvent).resolves.toMatchObject({
        type: 'event',
        event: 'exit',
        sessionId: 'missing-session',
        payload: { code: -1 }
      })
    })

    it('bypasses daemon stream batching for output after input', async () => {
      vi.useFakeTimers()
      try {
        let subprocess: ReturnType<typeof createMockSubprocess>
        server = new DaemonServer({
          socketPath,
          tokenPath,
          spawnSubprocess: () => {
            subprocess = createMockSubprocess()
            return subprocess
          }
        })
        const daemon = server as unknown as DaemonServerPrivate
        const controlSocket = { destroy: vi.fn() } as unknown as Socket
        const streamSocket = {
          destroyed: false,
          destroy: vi.fn(),
          write: vi.fn()
        } as unknown as Socket & { write: ReturnType<typeof vi.fn> }

        daemon.clients.set('client-1', {
          clientId: 'client-1',
          controlSocket,
          streamSocket,
          authenticatedPairEstablished: true
        })

        await daemon.routeRequest('client-1', {
          id: 'req-1',
          type: 'createOrAttach',
          payload: { sessionId: 'test-session', cols: 80, rows: 24 }
        })

        subprocess!._simulateData('background')
        expect(streamSocket.write).not.toHaveBeenCalled()
        vi.advanceTimersByTime(8)
        expect(streamSocket.write).toHaveBeenCalledTimes(1)
        expect(String(streamSocket.write.mock.calls[0]?.[0])).toContain('"data":"background"')

        streamSocket.write.mockClear()
        await daemon.routeRequest('client-1', {
          id: 'req-2',
          type: 'write',
          payload: { sessionId: 'test-session', data: 'x' }
        })

        expect(subprocess!.write).toHaveBeenCalledWith('x')
        subprocess!._simulateData('echo')
        expect(streamSocket.write).toHaveBeenCalledTimes(1)
        expect(String(streamSocket.write.mock.calls[0]?.[0])).toContain('"data":"echo"')
        vi.advanceTimersByTime(8)
        expect(streamSocket.write).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('flushes pending batched stream output before the exit event', async () => {
      vi.useFakeTimers()
      try {
        let subprocess: ReturnType<typeof createMockSubprocess>
        server = new DaemonServer({
          socketPath,
          tokenPath,
          spawnSubprocess: () => {
            subprocess = createMockSubprocess()
            return subprocess
          }
        })
        const daemon = server as unknown as DaemonServerPrivate
        const controlSocket = { destroy: vi.fn() } as unknown as Socket
        const streamSocket = {
          destroyed: false,
          destroy: vi.fn(),
          write: vi.fn()
        } as unknown as Socket & { write: ReturnType<typeof vi.fn> }

        daemon.clients.set('client-1', {
          clientId: 'client-1',
          controlSocket,
          streamSocket,
          authenticatedPairEstablished: true
        })

        await daemon.routeRequest('client-1', {
          id: 'req-1',
          type: 'createOrAttach',
          payload: { sessionId: 'test-session', cols: 80, rows: 24 }
        })

        subprocess!._simulateData('final-output')
        subprocess!._simulateExit(42)

        expect(streamSocket.write).toHaveBeenCalledTimes(2)
        expect(String(streamSocket.write.mock.calls[0]?.[0])).toContain('"event":"data"')
        expect(String(streamSocket.write.mock.calls[0]?.[0])).toContain('"data":"final-output"')
        expect(String(streamSocket.write.mock.calls[1]?.[0])).toContain('"event":"exit"')
        expect(String(streamSocket.write.mock.calls[1]?.[0])).toContain('"code":42')
        vi.advanceTimersByTime(8)
        expect(streamSocket.write).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps exit behind final output held by the shallow socket gate', async () => {
      vi.useFakeTimers()
      try {
        let subprocess: ReturnType<typeof createMockSubprocess>
        server = new DaemonServer({
          socketPath,
          tokenPath,
          spawnSubprocess: () => {
            subprocess = createMockSubprocess()
            return subprocess
          }
        })
        const daemon = server as unknown as DaemonServerPrivate
        const refillCallbacks: (() => void)[] = []
        const controlSocket = { destroy: vi.fn() } as unknown as Socket
        const streamSocket = {
          destroyed: false,
          destroy: vi.fn(),
          writableLength: 128 * 1024,
          write: vi.fn((_line: string, callback?: () => void) => {
            if (callback) {
              refillCallbacks.push(callback)
            }
            return true
          })
        } as unknown as Socket & {
          write: ReturnType<typeof vi.fn>
          writableLength: number
        }

        daemon.clients.set('client-1', {
          clientId: 'client-1',
          controlSocket,
          streamSocket,
          authenticatedPairEstablished: true
        })
        await daemon.routeRequest('client-1', {
          id: 'req-1',
          type: 'createOrAttach',
          payload: { sessionId: 'test-session', cols: 80, rows: 24 }
        })

        const finalOutput = 'final-output'.repeat(1024)
        subprocess!._simulateData(finalOutput)
        subprocess!._simulateExit(42)

        // Only the refill sentinel may enter the already-deep socket; exit
        // remains queued behind the final data for this session.
        expect(refillCallbacks).toHaveLength(1)
        const beforeRefill = streamSocket.write.mock.calls.map(([line]) => JSON.parse(String(line)))
        expect(beforeRefill).toHaveLength(1)
        expect(beforeRefill[0]).toMatchObject({ event: 'data', payload: { data: '' } })

        streamSocket.writableLength = 0
        refillCallbacks[0]()
        const delivered = streamSocket.write.mock.calls
          .map(
            ([line]) => JSON.parse(String(line)) as { event: string; payload: { data?: string } }
          )
          .filter((message) => message.payload.data !== '')
        expect(delivered.map((message) => message.event)).toEqual(['data', 'exit'])
        expect(delivered[0]?.payload.data).toBe(finalOutput)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('authentication', () => {
    it('rejects connections with wrong token', async () => {
      await startServer()

      // Connect with raw socket and send bad token
      const socket = connect(socketPath)
      await new Promise<void>((resolve) => socket.on('connect', resolve))

      socket.write(
        encodeNdjson({
          type: 'hello',
          version: PROTOCOL_VERSION,
          token: 'wrong-token',
          clientId: 'bad-client',
          role: 'control'
        })
      )

      const response = await new Promise<string>((resolve) => {
        socket.on('data', (data) => resolve(data.toString()))
      })

      const parsed = JSON.parse(response.trim())
      expect(parsed.ok).toBe(false)
      socket.destroy()
    })
  })

  describe('stream socket lifecycle', () => {
    it('clears the tracked stream socket when it closes', async () => {
      await startServer()
      const daemon = server as unknown as DaemonServerPrivate
      const control = await connectRawHello('control', 'raw-client')
      const stream = await connectRawHello('stream', 'raw-client')

      expect(daemon.clients.get('raw-client')?.streamSocket).toBeTruthy()

      stream.destroy()

      await waitFor(() => daemon.clients.get('raw-client')?.streamSocket === null)
      control.destroy()
    })

    it('destroys a replaced stream socket for the same client', async () => {
      await startServer()
      const daemon = server as unknown as DaemonServerPrivate
      const control = await connectRawHello('control', 'raw-client')
      const firstStream = await connectRawHello('stream', 'raw-client')
      let firstClosed = false
      firstStream.once('close', () => {
        firstClosed = true
      })

      const secondStream = await connectRawHello('stream', 'raw-client')

      await waitFor(() => firstClosed)
      expect(daemon.clients.get('raw-client')?.streamSocket).toBeTruthy()
      secondStream.destroy()
      control.destroy()
    })

    it('destroys previous sockets when a control client id reconnects', async () => {
      await startServer()
      const daemon = server as unknown as DaemonServerPrivate
      const firstControl = await connectRawHello('control', 'raw-client')
      const firstStream = await connectRawHello('stream', 'raw-client')
      let firstControlClosed = false
      let firstStreamClosed = false
      firstControl.once('close', () => {
        firstControlClosed = true
      })
      firstStream.once('close', () => {
        firstStreamClosed = true
      })

      const secondControl = await connectRawHello('control', 'raw-client')

      await waitFor(() => firstControlClosed && firstStreamClosed)
      expect(daemon.clients.get('raw-client')?.controlSocket).toBeTruthy()
      expect(daemon.clients.get('raw-client')?.streamSocket).toBeNull()
      secondControl.destroy()
    })

    it('destroys orphan stream sockets without a control client', async () => {
      await startServer()
      const daemon = server as unknown as DaemonServerPrivate
      const stream = await connectRawHello('stream', 'missing-client')
      let closed = false
      stream.once('close', () => {
        closed = true
      })

      await waitFor(() => closed || stream.destroyed)
      expect(daemon.clients.has('missing-client')).toBe(false)
    })
  })

  describe('shutdown', () => {
    it('waits for the ordinary shutdown reply write before destroying resources', async () => {
      await startServer()
      const c = await connectClient()
      const daemon = server as unknown as DaemonServerPrivate & {
        host: { dispose: () => Promise<void> }
      }
      const controlSocket = [...daemon.clients.values()][0].controlSocket
      const originalWrite = controlSocket.write.bind(controlSocket)
      let replyFlushed: (() => void) | undefined
      vi.spyOn(controlSocket, 'write').mockImplementation(((
        chunk: string | Uint8Array,
        ...args: unknown[]
      ) => {
        replyFlushed = args.find((arg) => typeof arg === 'function') as (() => void) | undefined
        return originalWrite(chunk)
      }) as unknown as Socket['write'])
      const dispose = vi.spyOn(daemon.host, 'dispose')

      await expect(c.request('shutdown', { killSessions: false })).resolves.toEqual({})
      expect(dispose).not.toHaveBeenCalled()
      expect(existsSync(tokenPath)).toBe(true)

      replyFlushed?.()
      await waitFor(() => !existsSync(tokenPath))
      expect(dispose).toHaveBeenCalledOnce()
    })

    it('removes only its owned token and PID record', async () => {
      const launchNonce = 'ordinary-shutdown'
      writeFileSync(
        pidPath,
        serializeDaemonPidFile({ pid: process.pid, startedAtMs: null, launchNonce })
      )
      await startServer(launchNonce)

      await server.shutdown()

      expect(existsSync(tokenPath)).toBe(false)
      expect(existsSync(pidPath)).toBe(false)
    })

    it('preserves token and PID artifacts replaced before ordinary cleanup', async () => {
      await startServer('mine')
      writeFileSync(tokenPath, 'replacement-token')
      writeFileSync(
        pidPath,
        serializeDaemonPidFile({
          pid: process.pid,
          startedAtMs: null,
          launchNonce: 'replacement'
        })
      )

      await server.shutdown()

      expect(readFileSync(tokenPath, 'utf8')).toBe('replacement-token')
      expect(JSON.parse(readFileSync(pidPath, 'utf8'))).toMatchObject({
        pid: process.pid,
        launchNonce: 'replacement'
      })
    })

    it('stops accepting connections after shutdown', async () => {
      await startServer()
      await server.shutdown()

      const c = new DaemonClient({ socketPath, tokenPath })
      await expect(c.ensureConnected()).rejects.toThrow()
    })

    it('still terminates via the shutdown RPC when disposal cannot prove physical exit', async () => {
      await startServer()
      const daemon = server as unknown as DaemonServerPrivate & {
        host: { dispose: () => Promise<void> }
      }
      // Why: an unreapable child rejects dispose after its exit deadline; the
      // daemon must exit anyway or its replacement flow strands it as an orphan.
      daemon.host.dispose = vi.fn(() =>
        Promise.reject(new Error('Timed out waiting for physical PTY exit'))
      )

      const c = await connectClient()
      await expect(c.request('shutdown', { killSessions: true })).resolves.toEqual({})

      await waitFor(() => daemon.server === null)
      await waitFor(() => !existsSync(socketPath))
      const late = new DaemonClient({ socketPath, tokenPath })
      await expect(late.ensureConnected()).rejects.toThrow()
    })
  })
})
