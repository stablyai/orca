import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { createServer, type Server, type Socket } from 'net'
import type { SubprocessHandle } from './session'
import type * as DaemonInitModule from './daemon-init'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock,
    getAppPath: () => process.cwd(),
    isPackaged: false
  }
}))

// Why: we want the real DaemonServer + DaemonClient but not electron-based
// subprocess spawning. createTestDaemon() wires a mock subprocess harness
// compatible with daemon-spawner.test.ts.
function createMockSubprocess(): SubprocessHandle {
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 77777,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 5)),
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData(_cb: (data: string) => void) {},
    onExit(cb: (code: number) => void) {
      onExitCb = cb
    }
  }
}

async function importFreshDaemonInit(): Promise<typeof DaemonInitModule> {
  vi.resetModules()
  return import('./daemon-init')
}

function writeNdjson(socket: Socket, message: unknown): void {
  socket.write(`${JSON.stringify(message)}\n`)
}

async function startLegacyDaemonStub(
  socketPath: string,
  tokenPath: string,
  protocolVersion = 1
): Promise<{ shutdown: () => Promise<void>; shutdownRequested: () => boolean }> {
  mkdirSync(join(tokenPath, '..'), { recursive: true })
  writeFileSync(tokenPath, 'legacy-token', { mode: 0o600 })
  let shutdownRequested = false

  const server = createServer((socket) => {
    let buffer = ''
    let greeted = false
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      for (;;) {
        const newlineIdx = buffer.indexOf('\n')
        if (newlineIdx === -1) {
          break
        }
        const line = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 1)
        const message = JSON.parse(line)
        if (!greeted) {
          greeted = true
          expect(message).toMatchObject({
            type: 'hello',
            version: protocolVersion,
            token: 'legacy-token'
          })
          writeNdjson(socket, { type: 'hello', ok: true })
          continue
        }
        if (message.type === 'listSessions') {
          writeNdjson(socket, {
            id: message.id,
            ok: true,
            payload: { sessions: [{ sessionId: 'legacy', isAlive: true }] }
          })
        } else if (message.type === 'shutdown') {
          shutdownRequested = true
          writeNdjson(socket, { id: message.id, ok: true, payload: {} })
          setTimeout(() => {
            socket.destroy()
            server.close(() => {
              if (process.platform !== 'win32') {
                try {
                  unlinkSync(socketPath)
                } catch {
                  // Best-effort
                }
              }
            })
          }, 0)
        }
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })

  return {
    shutdown: () => closeServer(server),
    shutdownRequested: () => shutdownRequested
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close(() => resolve())
  })
}

describe('cleanupOrphanedDaemon', () => {
  let userDataDir: string

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'daemon-init-test-'))
    getPathMock.mockImplementation(() => userDataDir)
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('returns cleaned=false when no daemon socket exists', async () => {
    const { cleanupOrphanedDaemon } = await importFreshDaemonInit()

    const result = await cleanupOrphanedDaemon()
    expect(result.cleaned).toBe(false)
    expect(result.killedCount).toBe(0)
  })

  it('removes stale pid files when no daemon socket exists', async () => {
    const { cleanupOrphanedDaemon } = await importFreshDaemonInit()
    const { getDaemonPidPath } = await import('./daemon-spawner')

    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(runtimeDir, { recursive: true })
    const pidPath = getDaemonPidPath(runtimeDir)
    writeFileSync(pidPath, '999999', { mode: 0o600 })

    const result = await cleanupOrphanedDaemon()

    expect(result.cleaned).toBe(false)
    expect(existsSync(pidPath)).toBe(false)
  })

  it('kills live sessions and shuts down a running daemon', async () => {
    const { cleanupOrphanedDaemon } = await importFreshDaemonInit()
    const { DaemonSpawner, getDaemonSocketPath } = await import('./daemon-spawner')
    const { startDaemon } = await import('./daemon-main')
    const { DaemonClient } = await import('./client')

    const runtimeDir = join(userDataDir, 'daemon')
    const { mkdirSync } = await import('fs')
    mkdirSync(runtimeDir, { recursive: true })

    // Spin up a real daemon exactly where cleanupOrphanedDaemon will look.
    const daemonHandles: { shutdown: () => Promise<void> }[] = []
    const spawner = new DaemonSpawner({
      runtimeDir,
      launcher: async (socketPath, tokenPath) => {
        const handle = await startDaemon({
          socketPath,
          tokenPath,
          spawnSubprocess: () => createMockSubprocess()
        })
        daemonHandles.push(handle)
        return { shutdown: () => handle.shutdown() }
      }
    })
    const info = await spawner.ensureRunning()

    // Create two sessions so killedCount is non-zero.
    const client = new DaemonClient({
      socketPath: info.socketPath,
      tokenPath: info.tokenPath
    })
    await client.ensureConnected()
    await client.request('createOrAttach', { sessionId: 'a', cols: 80, rows: 24 })
    await client.request('createOrAttach', { sessionId: 'b', cols: 80, rows: 24 })
    client.disconnect()

    // Now the daemon looks "orphaned" from cleanupOrphanedDaemon's POV.
    const result = await cleanupOrphanedDaemon()
    expect(result.cleaned).toBe(true)
    expect(result.killedCount).toBeGreaterThanOrEqual(2)

    // Socket file should be gone so a later opt-in relaunch can bind cleanly.
    if (process.platform !== 'win32') {
      expect(existsSync(getDaemonSocketPath(runtimeDir))).toBe(false)
    }

    // Best-effort teardown of any surviving handles from the spawner side.
    for (const handle of daemonHandles) {
      await handle.shutdown().catch(() => {})
    }
  })

  it('cleans up previous protocol daemons after a protocol bump', async () => {
    const { cleanupOrphanedDaemon } = await importFreshDaemonInit()
    const { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } =
      await import('./daemon-spawner')

    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(runtimeDir, { recursive: true })
    const legacySocketPath = getDaemonSocketPath(runtimeDir, 1)
    const legacyTokenPath = getDaemonTokenPath(runtimeDir, 1)
    const legacyPidPath = getDaemonPidPath(runtimeDir, 1)
    writeFileSync(legacyPidPath, String(process.pid), { mode: 0o600 })
    const legacyDaemon = await startLegacyDaemonStub(legacySocketPath, legacyTokenPath)

    try {
      const result = await cleanupOrphanedDaemon()

      expect(result).toEqual({ cleaned: true, killedCount: 1 })
      expect(legacyDaemon.shutdownRequested()).toBe(true)
      expect(existsSync(legacyPidPath)).toBe(false)
    } finally {
      await legacyDaemon.shutdown()
    }
  })

  it('cleans up v2 daemon sessions when daemon mode is disabled', async () => {
    const { cleanupOrphanedDaemon } = await importFreshDaemonInit()
    const { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } =
      await import('./daemon-spawner')

    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(runtimeDir, { recursive: true })
    const v2SocketPath = getDaemonSocketPath(runtimeDir, 2)
    const v2TokenPath = getDaemonTokenPath(runtimeDir, 2)
    const v2PidPath = getDaemonPidPath(runtimeDir, 2)
    writeFileSync(v2PidPath, String(process.pid), { mode: 0o600 })
    const v2Daemon = await startLegacyDaemonStub(v2SocketPath, v2TokenPath, 2)

    try {
      const result = await cleanupOrphanedDaemon()

      expect(result).toEqual({ cleaned: true, killedCount: 1 })
      expect(v2Daemon.shutdownRequested()).toBe(true)
      expect(existsSync(v2PidPath)).toBe(false)
    } finally {
      await v2Daemon.shutdown()
    }
  })

  it('does not report cleaned when fallback cleanup preserves an unowned live socket', async () => {
    if (process.platform === 'win32') {
      return
    }

    const { cleanupOrphanedDaemon } = await importFreshDaemonInit()
    const { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } =
      await import('./daemon-spawner')

    const runtimeDir = join(userDataDir, 'daemon')
    mkdirSync(runtimeDir, { recursive: true })
    const socketPath = getDaemonSocketPath(runtimeDir)
    const tokenPath = getDaemonTokenPath(runtimeDir)
    const server = createServer((socket) => {
      socket.once('data', () => socket.end('not daemon protocol\n'))
    })
    writeFileSync(tokenPath, 'bad-token', { mode: 0o600 })
    writeFileSync(getDaemonPidPath(runtimeDir), String(process.pid), { mode: 0o600 })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })

    try {
      const result = await cleanupOrphanedDaemon()

      expect(result).toEqual({ cleaned: false, killedCount: 0 })
      expect(existsSync(socketPath)).toBe(true)
    } finally {
      await closeServer(server)
    }
  })
})
