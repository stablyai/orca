import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as net from 'node:net'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { AgentLogger } from './agent-logger'
import {
  DaemonMessageDecoder,
  encodeDaemonMessage,
  type DaemonMessage
} from './pty-daemon-protocol'

// ── Fake node-pty (same shape as pty-agent-bridge.test.ts) ──────────────────
type FakePty = {
  onData: (cb: (data: string) => void) => void
  onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
}

function makeFakePty(): FakePty {
  return {
    onData: () => {},
    onExit: () => {},
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn()
  }
}

const spawnMock = vi.fn((..._args: unknown[]) => makeFakePty())
vi.mock('node-pty', () => ({ spawn: spawnMock }))

const log: AgentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
} as unknown as AgentLogger

function socketPathFor(name: string): string {
  return path.join(os.tmpdir(), `orca-pty-daemon-test-${name}-${process.pid}.sock`)
}

/** Minimal client: sends one request and resolves with the matching response. */
function requestOnce(
  socketPath: string,
  id: number,
  method: string,
  params?: Record<string, unknown>
): Promise<{ socket: net.Socket; response: DaemonMessage }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    const decoder = new DaemonMessageDecoder((msg) => {
      if ('id' in msg && msg.id === id) {
        resolve({ socket, response: msg })
      }
    })
    socket.on('data', (chunk) => decoder.feed(chunk.toString('utf8')))
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.write(encodeDaemonMessage({ id, method, params }))
    })
  })
}

describe('pty-daemon-server', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as unknown as never)
  })

  afterEach(() => {
    exitSpy.mockRestore()
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
  })

  it('responds to daemon.ping with the live PTY count', async () => {
    const { runPtyDaemon } = await import('./pty-daemon-server')
    const socketPath = socketPathFor('ping')
    void runPtyDaemon(socketPath, log)
    await vi.waitFor(() => {
      if (!fs.existsSync(socketPath)) {
        throw new Error('socket not ready')
      }
    })

    const { socket, response } = await requestOnce(socketPath, 1, 'daemon.ping')
    expect(response).toMatchObject({ id: 1, result: { ok: true, ptys: 0 } })
    socket.end()
  })

  it('spawns a PTY via pty.create and reports it in daemon.ping', async () => {
    const { runPtyDaemon } = await import('./pty-daemon-server')
    const socketPath = socketPathFor('create')
    void runPtyDaemon(socketPath, log)
    await vi.waitFor(() => {
      if (!fs.existsSync(socketPath)) {
        throw new Error('socket not ready')
      }
    })

    const created = await requestOnce(socketPath, 1, 'pty.create', { cols: 80, rows: 24 })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect((created.response as { result: { id: string } }).result.id).toMatch(/^agent-pty-/)

    const pinged = await requestOnce(socketPath, 2, 'daemon.ping')
    expect(pinged.response).toMatchObject({ id: 2, result: { ok: true, ptys: 1 } })
    created.socket.end()
    pinged.socket.end()
  })

  it('returns an error result for an unknown method instead of throwing', async () => {
    const { runPtyDaemon } = await import('./pty-daemon-server')
    const socketPath = socketPathFor('unknown-method')
    void runPtyDaemon(socketPath, log)
    await vi.waitFor(() => {
      if (!fs.existsSync(socketPath)) {
        throw new Error('socket not ready')
      }
    })

    const { socket, response } = await requestOnce(socketPath, 1, 'not.a.real.method')
    expect(response).toMatchObject({
      id: 1,
      error: { message: expect.stringContaining('Unknown daemon method') }
    })
    socket.end()
  })

  it('exits immediately without binding when another daemon already owns the socket', async () => {
    const { runPtyDaemon } = await import('./pty-daemon-server')
    const socketPath = socketPathFor('dedup')

    // First instance binds for real.
    void runPtyDaemon(socketPath, log)
    await vi.waitFor(() => {
      if (!fs.existsSync(socketPath)) {
        throw new Error('socket not ready')
      }
    })
    exitSpy.mockClear()

    // Real process.exit(0) never returns — simulate that here so the mocked call
    // can't fall through into unlinking/re-listening on the first instance's live socket.
    exitSpy.mockImplementation((() => {
      throw new Error('process.exit(0) called')
    }) as never)

    // Second instance should probe, find the first alive, and exit(0) instead of rebinding.
    await expect(runPtyDaemon(socketPath, log)).rejects.toThrow('process.exit(0) called')
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('daemon.sessionClosed arms a grace-period kill for existing PTYs', async () => {
    const { runPtyDaemon } = await import('./pty-daemon-server')
    const { PTY_GRACE_PERIOD_MS } = await import('./pty-agent-bridge')
    const socketPath = socketPathFor('grace')
    void runPtyDaemon(socketPath, log)
    // setImmediate is real here — fake timers (below) only replace setTimeout/clearTimeout,
    // so this poll still ticks even once the daemon's own grace-period timer is faked.
    while (!fs.existsSync(socketPath)) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const created = await requestOnce(socketPath, 1, 'pty.create', {})
    const pty = spawnMock.mock.results.at(-1)!.value as FakePty

    const closed = await requestOnce(socketPath, 2, 'daemon.sessionClosed')
    expect(closed.response).toMatchObject({ id: 2, result: { ok: true } })

    await vi.advanceTimersByTimeAsync(PTY_GRACE_PERIOD_MS + 10)
    expect(pty.kill).toHaveBeenCalledWith('SIGTERM')

    created.socket.end()
    closed.socket.end()
    vi.useRealTimers()
  })

  // CR-STORAGE-008(a)/TASK-AG-STORAGE-007: confirmed-logout path — kills
  // immediately, unlike daemon.sessionClosed's grace-period arm above.
  it('daemon.sessionTeardown kills existing PTYs immediately, no grace period', async () => {
    const { runPtyDaemon } = await import('./pty-daemon-server')
    const socketPath = socketPathFor('teardown')
    void runPtyDaemon(socketPath, log)
    while (!fs.existsSync(socketPath)) {
      await new Promise((resolve) => setImmediate(resolve))
    }

    const created = await requestOnce(socketPath, 1, 'pty.create', {})
    const pty = spawnMock.mock.results.at(-1)!.value as FakePty

    const torn = await requestOnce(socketPath, 2, 'daemon.sessionTeardown')
    expect(torn.response).toMatchObject({ id: 2, result: { ok: true } })

    // No grace period to wait out — the kill already happened synchronously
    // inside dispatchDaemonRequest.
    expect(pty.kill).toHaveBeenCalledWith('SIGTERM')

    created.socket.end()
    torn.socket.end()
  })
})
