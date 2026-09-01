import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import {
  LAUNCH_TOKEN_ECHO_DAEMON_PROTOCOL_VERSION,
  PROTOCOL_VERSION
} from './daemon-protocol-version'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import { Session, type SubprocessHandle } from './session'
import { TerminalHost } from './terminal-host'

function mockSubprocess(): SubprocessHandle {
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 123,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 5)),
    forceKill: vi.fn(() => onExitCb?.(137)),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((cb: (code: number) => void) => {
      onExitCb = cb
    }),
    dispose: vi.fn()
  } as unknown as SubprocessHandle
}

describe('Session launchToken persistence', () => {
  it('persists the launch token on the record at creation', () => {
    const session = new Session({
      sessionId: 's-1',
      cols: 80,
      rows: 24,
      subprocess: mockSubprocess(),
      shellReadySupported: false,
      launchToken: 'tok-abc'
    })
    expect(session.launchToken).toBe('tok-abc')
    session.dispose()
  })

  it('defaults to null when no launch token is supplied', () => {
    const session = new Session({
      sessionId: 's-2',
      cols: 80,
      rows: 24,
      subprocess: mockSubprocess(),
      shellReadySupported: false
    })
    expect(session.launchToken).toBeNull()
    session.dispose()
  })
})

describe('launch-token re-list echo', () => {
  // Crash reconciliation rejoins a daemon-surviving PTY to its pending launch
  // by matching the re-listed token; a persisted-but-not-echoed token would
  // false-settle spawn_failed for a live terminal.
  it('TerminalHost.listSessions echoes launchToken and omits it for tokenless sessions', async () => {
    const host = new TerminalHost({ spawnSubprocess: () => mockSubprocess() })
    const streamClient = () => ({ onData: vi.fn(), onExit: vi.fn() })
    await host.createOrAttach({
      sessionId: 'wt@@a',
      cols: 80,
      rows: 24,
      launchToken: 'tok-echo',
      streamClient: streamClient()
    })
    await host.createOrAttach({
      sessionId: 'wt@@b',
      cols: 80,
      rows: 24,
      streamClient: streamClient()
    })
    const infos = host.listSessions()
    expect(infos.find((s) => s.sessionId === 'wt@@a')?.launchToken).toBe('tok-echo')
    const tokenless = infos.find((s) => s.sessionId === 'wt@@b')
    expect(tokenless).toBeDefined()
    expect(tokenless && 'launchToken' in tokenless).toBe(false)
    await host.dispose()
  })

  it('DaemonPtyAdapter surfaces the spawn token on listProcesses and listSessions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daemon-launch-token-'))
    const socketPath = getDaemonSocketPath(dir)
    const tokenPath = join(dir, 'test.token')
    const server = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: () => mockSubprocess()
    })
    await server.start()
    const adapter = new DaemonPtyAdapter({ socketPath, tokenPath })
    try {
      expect(adapter.providesLaunchTokenListings()).toBe(true)
      const spawned = await adapter.spawn({ cols: 80, rows: 24, launchToken: 'tok-reconcile' })
      const processes = await adapter.listProcesses()
      expect(processes.find((p) => p.id === spawned.id)?.launchToken).toBe('tok-reconcile')
      const sessions = await adapter.listSessions()
      expect(sessions.find((s) => s.sessionId === spawned.id)?.launchToken).toBe('tok-reconcile')
    } finally {
      adapter.dispose()
      await server.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('launch-token wire negotiation across daemon generations', () => {
  async function withDaemon(
    protocolVersion: number,
    run: (adapter: DaemonPtyAdapter) => Promise<void>
  ): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'daemon-launch-token-skew-'))
    const socketPath = getDaemonSocketPath(dir, protocolVersion)
    const tokenPath = join(dir, 'test.token')
    const server = new DaemonServer({
      socketPath,
      tokenPath,
      protocolVersion,
      spawnSubprocess: () => mockSubprocess()
    })
    await server.start()
    const adapter = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion })
    try {
      await run(adapter)
    } finally {
      adapter.dispose()
      await server.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // New main + old daemon: v33 shipped launchToken with no bump, so a daemon preserved
  // across the update drops the token it is handed and can never echo it back.
  it('withholds the token from a pre-echo daemon and disclaims listing authority', async () => {
    await withDaemon(LAUNCH_TOKEN_ECHO_DAEMON_PROTOCOL_VERSION - 1, async (adapter) => {
      expect(adapter.providesLaunchTokenListings()).toBe(false)
      const spawned = await adapter.spawn({ cols: 80, rows: 24, launchToken: 'tok-legacy' })
      const listed = (await adapter.listProcesses()).find((p) => p.id === spawned.id)
      expect(listed).toBeDefined()
      expect(listed && 'launchToken' in listed).toBe(false)
    })
  })

  // Old main + new daemon: the hello enforces an exact generation match, so an old main
  // never reads a v34 echo — and the field stays optional for tokenless creates.
  it('keeps the echo optional and refuses a cross-generation client', async () => {
    await withDaemon(PROTOCOL_VERSION, async (adapter) => {
      const spawned = await adapter.spawn({ cols: 80, rows: 24 })
      const listed = (await adapter.listProcesses()).find((p) => p.id === spawned.id)
      expect(listed).toBeDefined()
      expect(listed && 'launchToken' in listed).toBe(false)
    })

    const dir = mkdtempSync(join(tmpdir(), 'daemon-launch-token-downgrade-'))
    const socketPath = getDaemonSocketPath(dir, PROTOCOL_VERSION)
    const tokenPath = join(dir, 'test.token')
    const server = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: () => mockSubprocess()
    })
    await server.start()
    const oldMain = new DaemonPtyAdapter({
      socketPath,
      tokenPath,
      protocolVersion: LAUNCH_TOKEN_ECHO_DAEMON_PROTOCOL_VERSION - 1
    })
    try {
      await expect(oldMain.listProcesses()).rejects.toThrow()
    } finally {
      oldMain.dispose()
      await server.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
