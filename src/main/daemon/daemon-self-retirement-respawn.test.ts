import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import type { SubprocessHandle } from './session'

function fixtureSubprocess(): SubprocessHandle {
  let onExit: ((code: number) => void) | null = null
  return {
    pid: process.pid,
    getForegroundProcess: () => null,
    write: () => {},
    resize: () => {},
    kill: () => queueMicrotask(() => onExit?.(0)),
    forceKill: () => queueMicrotask(() => onExit?.(137)),
    signal: () => {},
    onData: () => {},
    onExit: (callback) => {
      onExit = callback
    },
    dispose: () => {}
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for daemon disconnect')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('daemon self-retirement respawn', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer | null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-retirement-respawn-'))
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'daemon.token')
    server = null
  })

  afterEach(async () => {
    await server?.shutdown().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  async function startServer(): Promise<DaemonServer> {
    const next = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: () => fixtureSubprocess()
    })
    await next.start()
    server = next
    return next
  }

  it('coalesces respawn after an authenticated endpoint removes its token', async () => {
    const original = await startServer()
    const respawn = vi.fn(async () => {
      await startServer()
    })
    const adapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn })
    await adapter.listProcesses()
    const client = (
      adapter as unknown as {
        client: { hasObservedAuthenticatedDisconnect(): boolean }
      }
    ).client

    await original.shutdown()
    await waitFor(() => client.hasObservedAuthenticatedDisconnect())

    await Promise.all([
      adapter.spawn({ sessionId: 'first', cols: 80, rows: 24 }),
      adapter.spawn({ sessionId: 'second', cols: 80, rows: 24 })
    ])

    expect(respawn).toHaveBeenCalledTimes(1)
    adapter.dispose()
  })

  it('releases the temporary respawn lease before clean retirement', async () => {
    const original = await startServer()
    let temporaryAdapter: DaemonPtyAdapter | null = null
    const releaseTemporaryLease = vi.fn(() => temporaryAdapter?.dispose())
    const respawn = vi.fn(async () => {
      await startServer()
      temporaryAdapter = new DaemonPtyAdapter({ socketPath, tokenPath })
      await temporaryAdapter.establishLifecycleLease()
      return releaseTemporaryLease
    })
    const adapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn })
    await adapter.listProcesses()
    const client = (
      adapter as unknown as {
        client: { hasObservedAuthenticatedDisconnect(): boolean }
      }
    ).client
    await original.shutdown()
    await waitFor(() => client.hasObservedAuthenticatedDisconnect())

    await adapter.spawn({ sessionId: 'respawned', cols: 80, rows: 24 })
    expect(releaseTemporaryLease).toHaveBeenCalledOnce()
    await adapter.shutdown('respawned', { immediate: true })
    await adapter.disconnectOnly()

    await waitFor(() => !existsSync(tokenPath))
  })

  it('releases a temporary lease when a tombstone wins the respawn race', async () => {
    const original = await startServer()
    let temporaryAdapter: DaemonPtyAdapter | null = null
    const releaseTemporaryLease = vi.fn(() => temporaryAdapter?.dispose())
    let adapter!: DaemonPtyAdapter
    const respawn = vi.fn(async () => {
      await startServer()
      temporaryAdapter = new DaemonPtyAdapter({ socketPath, tokenPath })
      await temporaryAdapter.establishLifecycleLease()
      const tombstones = (adapter as unknown as { killedSessionTombstones: Map<string, number> })
        .killedSessionTombstones
      tombstones.set('closed-during-respawn', Date.now())
      return releaseTemporaryLease
    })
    adapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn })
    await adapter.listProcesses()
    const client = (
      adapter as unknown as {
        client: { hasObservedAuthenticatedDisconnect(): boolean }
      }
    ).client
    await original.shutdown()
    await waitFor(() => client.hasObservedAuthenticatedDisconnect())

    await expect(
      adapter.spawn({ sessionId: 'closed-during-respawn', cols: 80, rows: 24 })
    ).rejects.toThrow('was explicitly killed')

    expect(releaseTemporaryLease).toHaveBeenCalledOnce()
    adapter.dispose()
  })

  it('releases a lease returned after disposal and does not reconnect', async () => {
    const original = await startServer()
    let temporaryAdapter: DaemonPtyAdapter | null = null
    const releaseTemporaryLease = vi.fn(() => temporaryAdapter?.dispose())
    let returnRespawnLease!: () => void
    const respawn = vi.fn(async () => {
      await startServer()
      temporaryAdapter = new DaemonPtyAdapter({ socketPath, tokenPath })
      await temporaryAdapter.establishLifecycleLease()
      await new Promise<void>((resolve) => {
        returnRespawnLease = resolve
      })
      return releaseTemporaryLease
    })
    const adapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn })
    await adapter.listProcesses()
    const client = (
      adapter as unknown as {
        client: { hasObservedAuthenticatedDisconnect(): boolean; isConnected(): boolean }
      }
    ).client
    await original.shutdown()
    await waitFor(() => client.hasObservedAuthenticatedDisconnect())

    const spawn = adapter.spawn({ sessionId: 'disposed', cols: 80, rows: 24 })
    await waitFor(() => returnRespawnLease !== undefined)
    adapter.dispose()
    returnRespawnLease()

    await expect(spawn).rejects.toThrow('closed during respawn')
    expect(releaseTemporaryLease).toHaveBeenCalledOnce()
    expect(client.isConnected()).toBe(false)
  })

  it('does not start a respawn after disposal rejects an in-flight operation', async () => {
    await startServer()
    const respawn = vi.fn(async () => {})
    const adapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn })
    await adapter.establishLifecycleLease()
    let rejectCreate!: (error: Error) => void
    const client = (
      adapter as unknown as {
        client: {
          request: (method: string, params: unknown) => Promise<unknown>
        }
      }
    ).client
    vi.spyOn(client, 'request').mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectCreate = reject
        })
    )

    const spawn = adapter.spawn({ sessionId: 'disposed-in-flight', cols: 80, rows: 24 })
    await waitFor(() => rejectCreate !== undefined)
    adapter.dispose()
    rejectCreate(new Error('Connection lost'))

    await expect(spawn).rejects.toThrow('Connection lost')
    expect(respawn).not.toHaveBeenCalled()
  })

  it('does not treat an initial missing token as respawn authority', async () => {
    const respawn = vi.fn(async () => {})
    const adapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn })

    await expect(adapter.spawn({ sessionId: 'missing', cols: 80, rows: 24 })).rejects.toMatchObject(
      {
        code: 'ENOENT'
      }
    )

    expect(respawn).not.toHaveBeenCalled()
    adapter.dispose()
  })
})
