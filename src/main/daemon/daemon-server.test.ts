/* eslint-disable max-lines -- Why: daemon server RPC, auth, stream batching, and shutdown behavior share one socket/client harness; splitting would duplicate setup. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect, type Server, type Socket } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { DaemonServer } from './daemon-server'
import { DaemonClient } from './client'
import { encodeNdjson } from './ndjson'
import { PROTOCOL_VERSION, type DaemonRequest } from './types'
import type { SubprocessHandle } from './session'

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
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 5)),
    forceKill: vi.fn(),
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
  clients: Map<
    string,
    {
      clientId: string
      controlSocket: Socket
      streamSocket: Socket | null
    }
  >
  routeRequest(clientId: string, request: DaemonRequest): Promise<unknown>
}

describe('DaemonServer', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let client: DaemonClient

  beforeEach(() => {
    dir = createTestDir()
    socketPath = join(dir, 'test.sock')
    tokenPath = join(dir, 'test.token')
  })

  afterEach(async () => {
    client?.disconnect()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  async function startServer(): Promise<void> {
    server = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: () => createMockSubprocess()
    })
    await server.start()
  }

  async function connectClient(): Promise<DaemonClient> {
    client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    return client
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
          streamSocket
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
          streamSocket
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

  describe('shutdown', () => {
    it('stops accepting connections after shutdown', async () => {
      await startServer()
      await server.shutdown()

      const c = new DaemonClient({ socketPath, tokenPath })
      await expect(c.ensureConnected()).rejects.toThrow()
    })
  })
})
