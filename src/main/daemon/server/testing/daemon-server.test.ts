import '../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { DaemonServer } from '../daemon-server'
import { DaemonClient } from '../../transport/client/daemon-client'
import { encodeNdjson } from '../../../../shared/json-stream/main-process-ndjson-framer'
import { PROTOCOL_VERSION } from '../../protocol/daemon-protocol-version'
import type { GetSnapshotResult } from '../../protocol/daemon-rpc-contract'
import type { TerminalVisibleProjectionSnapshot } from '../../protocol/terminal-snapshot'
import type { SubprocessHandle } from '../../sessions/session-subprocess-handle'
import {
  getDaemonPidPath,
  getDaemonSocketPath,
  serializeDaemonPidFile
} from '../../launch/daemon-spawner'

const confirmForegroundProcessMock = vi.fn(async () => 'droid')

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'daemon-server-test-'))
}

function createMockSubprocess(): SubprocessHandle {
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 55555,
    getForegroundProcess: vi.fn(() => null),
    confirmForegroundProcess: confirmForegroundProcessMock,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 5)),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => onExitCb?.(137)),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit(cb) {
      onExitCb = cb
    },
    dispose: vi.fn()
  }
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

  describe('RPC routing', () => {
    it('returns the active screen and stream position without ANSI when requested', async () => {
      const output = Promise.withResolvers<(data: string) => void>()
      server = new DaemonServer({
        socketPath,
        tokenPath,
        spawnSubprocess: () => ({ ...createMockSubprocess(), onData: output.resolve })
      })
      await server.start()
      const c = await connectClient()
      expect(c.supportsVisibleProjectionSnapshot()).toBe(true)
      const sessionId = 'visible-snapshot'
      await c.request('createOrAttach', {
        sessionId,
        cols: 80,
        rows: 24
      })
      const emit = await output.promise
      emit('\x1b]2;Build\x07\x1b[?1049hBuild passed\r\nReady')

      const { snapshot } = await c.request<GetSnapshotResult<TerminalVisibleProjectionSnapshot>>(
        'getSnapshot',
        { sessionId, scrollbackRows: 0, visibleProjection: true }
      )
      expect(snapshot).toMatchObject({
        cols: 80,
        rows: 24,
        modes: { alternateScreen: true },
        lastTitle: 'Build',
        outputSequence: 37,
        visibleProjection: {
          lines: ['Build passed', 'Ready'],
          tailRows: [
            { wrapped: false, trailingSpaces: 0 },
            { wrapped: false, trailingSpaces: 0 }
          ]
        }
      })
      expect(snapshot).not.toHaveProperty('snapshotAnsi')
      expect(snapshot).not.toHaveProperty('scrollbackAnsi')
      expect(snapshot).not.toHaveProperty('frameRestoreAnsi')

      const legacy = await c.request<GetSnapshotResult>('getSnapshot', {
        sessionId,
        scrollbackRows: 0
      })
      expect(legacy.snapshot?.snapshotAnsi).toContain('Build passed')
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

      // Synchronous preflight previously blocked RPC and live PTY traffic.
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
        await expect(cancelRequest).resolves.toEqual(
          requestType === 'kill' ? {} : { canceled: true }
        )
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
  })

  describe('authentication', () => {
    it('rejects connections with wrong token', async () => {
      await startServer()

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
  })
})
