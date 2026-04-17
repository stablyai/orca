import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { DaemonServer } from './daemon-server'
import { DaemonClient } from './client'
import { encodeNdjson } from './ndjson'
import { PROTOCOL_VERSION } from './types'
import type { SubprocessHandle } from './session'

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'daemon-server-test-'))
}

function createMockSubprocess(): SubprocessHandle {
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 55555,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 5)),
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData(_cb) {
      /* stored for future tests */
    },
    onExit(cb) {
      onExitCb = cb
    }
  }
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

      // Mock subprocess doesn't emit OSC-7, so cwd is null
      expect(result.cwd).toBeNull()
    })

    it('returns error for unknown session operations', async () => {
      await startServer()
      const c = await connectClient()

      await expect(c.request('write', { sessionId: 'nonexistent', data: 'hi' })).rejects.toThrow(
        'Session not found'
      )
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
