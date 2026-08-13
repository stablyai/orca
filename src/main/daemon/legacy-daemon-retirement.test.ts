/**
 * Stranded-daemon regression: Windows has no endpoint-ownership retirement, so a superseded daemon
 * lingers for the machine's uptime — five accumulated on one host, the oldest 12 days old. A legacy
 * daemon that owns nothing must retire; one that still owns sessions, or cannot be inventoried, must not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { CLEAN_DISCONNECT_PROTOCOL_VERSION, PROTOCOL_VERSION } from './daemon-protocol-version'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import { TerminalHost } from './terminal-host'
import type { SubprocessHandle } from './session'

function fixtureSubprocess(): SubprocessHandle {
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 1234,
    getForegroundProcess: () => null,
    write: () => {},
    resize: () => {},
    kill: () => {
      setTimeout(() => onExitCb?.(0), 1)
    },
    forceKill: () => onExitCb?.(137),
    signal: () => {},
    onData: () => {},
    onExit: (cb) => {
      onExitCb = cb
    },
    dispose: () => {}
  } as SubprocessHandle
}

describe('legacy daemon retirement', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer | null
  let adapter: DaemonPtyAdapter | null
  let owner: DaemonPtyAdapter | null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'legacy-daemon-retirement-'))
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'daemon.token')
    server = null
    adapter = null
    owner = null
  })

  afterEach(async () => {
    await adapter?.disconnectOnly().catch(() => {})
    await owner?.disconnectOnly().catch(() => {})
    await server?.shutdown().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  async function startServer(protocolVersion = PROTOCOL_VERSION): Promise<DaemonServer> {
    const started = new DaemonServer({
      socketPath,
      tokenPath,
      protocolVersion,
      spawnSubprocess: () => fixtureSubprocess()
    })
    await started.start()
    server = started
    return started
  }

  function createAdapter(protocolVersion = PROTOCOL_VERSION): DaemonPtyAdapter {
    adapter = new DaemonPtyAdapter({
      socketPath,
      tokenPath,
      protocolVersion,
      profileScope: dir,
      historyPath: join(dir, 'history')
    })
    return adapter
  }

  it('retires a daemon that owns no sessions', async () => {
    await startServer()
    const retired = await createAdapter().retireIfEmpty()
    expect(retired).toBe(true)
  })

  it('preserves a daemon that still owns a live session', async () => {
    await startServer()
    owner = new DaemonPtyAdapter({
      socketPath,
      tokenPath,
      profileScope: dir,
      historyPath: join(dir, 'history')
    })
    await owner.spawn({ sessionId: 'still-owned', cols: 80, rows: 24 })

    const retired = await createAdapter().retireIfEmpty()

    expect(retired).toBe(false)
    // The session the stranded daemon still owns is untouched.
    expect(await owner.listSessions()).toHaveLength(1)
  })

  it('preserves an empty daemon when another client wins the retirement race', async () => {
    await startServer()
    owner = new DaemonPtyAdapter({ socketPath, tokenPath, profileScope: dir })
    await owner.establishLifecycleLease()
    const candidate = createAdapter()

    const retired = await candidate.retireIfEmpty()
    await owner.spawn({ sessionId: 'created-after-refusal', cols: 80, rows: 24 })

    expect(retired).toBe(false)
    expect(await candidate.listSessions()).toHaveLength(1)
  })

  it('preserves protocols that predate atomic idle retirement', async () => {
    const protocolVersion = CLEAN_DISCONNECT_PROTOCOL_VERSION - 1
    await startServer(protocolVersion)
    const candidate = createAdapter(protocolVersion)

    const retired = await candidate.retireIfEmpty()

    expect(retired).toBe(false)
    expect(await candidate.listSessions()).toEqual([])
  })

  it('fails closed when the daemon cannot be reached at all', async () => {
    // No server listening: the inventory is unverifiable, so the daemon must be preserved and routed.
    const retired = await createAdapter().retireIfEmpty()
    expect(retired).toBe(false)
  })

  it('fails closed rather than hanging on a wedged daemon that never answers hello', async () => {
    // A stale daemon can accept the socket and never reply. Without a budget this would block the
    // startup path on the client's 30s request timeout — on the machine least able to afford it.
    writeFileSync(tokenPath, 'wedged-token', { mode: 0o600 })
    const accepted: Socket[] = []
    const wedged = createServer((socket) => {
      // Accept and go silent.
      accepted.push(socket)
    })
    await new Promise<void>((resolve) => wedged.listen(socketPath, resolve))
    try {
      const startedAt = Date.now()

      const retired = await createAdapter().retireIfEmpty(200)

      expect(retired).toBe(false)
      expect(Date.now() - startedAt).toBeLessThan(1_000)
    } finally {
      // close() alone waits on live connections, and the adapter's sockets are still open.
      for (const socket of accepted) {
        socket.destroy()
      }
      await new Promise<void>((resolve) => wedged.close(() => resolve()))
    }
  })

  it('bounds the atomic shutdown by the caller budget and asks only for it', async () => {
    const started = await startServer()
    const serverInternals = started as unknown as {
      routeRequest(clientId: string, request: { type: string }): Promise<unknown>
    }
    const routeRequest = serverInternals.routeRequest.bind(started)
    serverInternals.routeRequest = async (clientId, request) => {
      if (request.type === 'shutdownIfIdle') {
        return new Promise<never>(() => {})
      }
      return routeRequest(clientId, request)
    }
    const candidate = createAdapter()
    const client = (candidate as unknown as { client: DaemonClient }).client
    const request = vi.spyOn(client, 'request')
    const startedAt = Date.now()

    let retired: boolean
    try {
      retired = await candidate.retireIfEmpty(200)
    } finally {
      serverInternals.routeRequest = routeRequest
    }

    const elapsedMs = Date.now() - startedAt
    const requestTypes = request.mock.calls.map(([type]) => type)
    const shutdownTimeoutMs = request.mock.calls.find(([type]) => type === 'shutdownIfIdle')?.[2]
    expect(retired).toBe(false)
    // The daemon proves emptiness itself, so retirement costs exactly one round trip.
    expect(requestTypes).toEqual(['shutdownIfIdle'])
    expect(shutdownTimeoutMs).toEqual(expect.any(Number))
    expect(shutdownTimeoutMs).toBeGreaterThan(0)
    expect(shutdownTimeoutMs).toBeLessThanOrEqual(200)
    expect(elapsedMs).toBeLessThan(300)
  })

  it('does not report empty while a session is exited but unreaped', async () => {
    // Why: the live-session list hides a session that reached 'exited' but whose reap never fired, yet
    // the host still holds its subprocess handle and any surviving descendants keep a cwd open inside
    // the worktree — which is what later makes a worktree delete fail with the dir still in use.
    // Asserted on the host directly: through the protocol, clients.size would refuse first and this
    // would pass without ever exercising the emptiness proof.
    const host = new TerminalHost({ spawnSubprocess: () => fixtureSubprocess() })
    await host.createOrAttach({
      sessionId: 'exited-not-reaped',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    const sessions = (host as unknown as { sessions: Map<string, { _state: string }> }).sessions
    const session = sessions.get('exited-not-reaped')
    expect(session).toBeDefined()
    // Reach 'exited' without firing onExit, i.e. the reap that should have removed it never ran.
    session!._state = 'exited'

    // The weaker check the daemon used to retire on sees nothing here.
    expect(host.listSessions()).toHaveLength(0)
    // The stricter one still sees the handle.
    expect(host.ownsNothing()).toBe(false)

    await host.dispose()
  })

  it('reports empty only once every session is gone', async () => {
    const host = new TerminalHost({ spawnSubprocess: () => fixtureSubprocess() })
    expect(host.ownsNothing()).toBe(true)
    await host.createOrAttach({
      sessionId: 'live',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    expect(host.ownsNothing()).toBe(false)
    await host.dispose()
  })
})
