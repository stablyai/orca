import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonClient } from './client'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import type { SubprocessHandle } from './session-subprocess-handle'

function createMockSubprocess(): SubprocessHandle {
  let onExit: ((code: number) => void) | undefined
  return {
    pid: 55555,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => onExit?.(0)),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => onExit?.(137)),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((callback) => {
      onExit = callback
    }),
    dispose: vi.fn()
  }
}

describe('DaemonServer attach-only preparation', () => {
  const servers: DaemonServer[] = []
  const clients: DaemonClient[] = []
  const directories: string[] = []

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.disconnect()
    }
    await Promise.all(servers.splice(0).map((server) => server.shutdown()))
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('skips fresh-spawn preparation when attaching only', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'daemon-attach-only-test-'))
    directories.push(directory)
    const socketPath = getDaemonSocketPath(directory)
    const tokenPath = join(directory, 'test.token')
    const preparePtySpawn = vi.fn(async () => {})
    const server = new DaemonServer({
      socketPath,
      tokenPath,
      preparePtySpawn,
      spawnSubprocess: () => createMockSubprocess()
    })
    servers.push(server)
    await server.start()
    const client = new DaemonClient({ socketPath, tokenPath })
    clients.push(client)
    await client.ensureConnected()
    await client.request('createOrAttach', {
      sessionId: 'stable-pane-session',
      cols: 80,
      rows: 24
    })

    await expect(
      client.request('createOrAttach', {
        sessionId: 'stable-pane-session',
        cols: 120,
        rows: 40,
        attachOnly: true
      })
    ).resolves.toMatchObject({ isNew: false })
    expect(preparePtySpawn).toHaveBeenCalledOnce()
  })

  it('prepares a fresh spawn when attachOnly is not the boolean true', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'daemon-attach-only-shape-test-'))
    directories.push(directory)
    const socketPath = getDaemonSocketPath(directory)
    const tokenPath = join(directory, 'test.token')
    const preparePtySpawn = vi.fn(async () => {})
    const server = new DaemonServer({
      socketPath,
      tokenPath,
      preparePtySpawn,
      spawnSubprocess: () => createMockSubprocess()
    })
    servers.push(server)
    await server.start()
    const client = new DaemonClient({ socketPath, tokenPath })
    clients.push(client)
    await client.ensureConnected()

    await expect(
      client.request('createOrAttach', {
        sessionId: 'malformed-attach-only-session',
        cols: 80,
        rows: 24,
        attachOnly: 'false' as never
      })
    ).resolves.toMatchObject({ isNew: true })
    expect(preparePtySpawn).toHaveBeenCalledOnce()
  })
})
