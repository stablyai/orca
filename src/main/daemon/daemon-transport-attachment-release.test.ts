import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import type { Session } from './session'
import type { SubprocessHandle } from './session-subprocess-handle'

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
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: () => onExitCb?.(137),
    signal: () => {},
    onData: () => {},
    onExit: (cb) => {
      onExitCb = cb
    },
    dispose: () => {}
  } as SubprocessHandle
}

describe('transport-drop attachment release', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer | null
  let adapter: DaemonPtyAdapter | null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-attachment-release-'))
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'daemon.token')
    server = null
    adapter = null
  })

  afterEach(async () => {
    await adapter?.disconnectOnly().catch(() => {})
    await server?.shutdown().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  function sessionOf(started: DaemonServer, sessionId: string): Session | undefined {
    const host = (started as unknown as { host: { sessions: Map<string, Session> } }).host
    return host.sessions.get(sessionId)
  }

  it('releases a dropped client transport instead of leaving a phantom attachment', async () => {
    const started = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: () => fixtureSubprocess()
    })
    await started.start()
    server = started

    adapter = new DaemonPtyAdapter({
      socketPath,
      tokenPath,
      profileScope: dir,
      historyPath: join(dir, 'history')
    })
    await adapter.spawn({ sessionId: 'viewed-then-dropped', cols: 80, rows: 24 })

    const session = sessionOf(started, 'viewed-then-dropped')
    expect(session).toBeDefined()
    expect(session!.hasAttachedClients).toBe(true)

    // Simulate abrupt transport loss without a protocol detach.
    const client = (adapter as unknown as { client: { disconnect(): void } }).client
    client.disconnect()

    await vi.waitFor(() => {
      expect(session!.hasAttachedClients).toBe(false)
    })
    expect(session!.isAlive).toBe(true)
  })
})
