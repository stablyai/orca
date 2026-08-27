import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonClient } from './client'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
type DaemonServerInternals = {
  preparations: {
    pending: Map<string, Set<{ canceled: boolean }>>
  }
  host: { listSessions: () => unknown[] }
}

describe('daemon async spawn cancellation', () => {
  let directory: string
  let server: DaemonServer
  let client: DaemonClient
  let releaseSpawn: () => void
  let spawnStarted: Promise<void>
  let subprocess: ReturnType<typeof createMockSubprocess>

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'daemon-async-spawn-cancel-'))
    let markSpawnStarted: () => void = () => {}
    spawnStarted = new Promise<void>((resolve) => {
      markSpawnStarted = resolve
    })
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve
    })
    server = new DaemonServer({
      socketPath: getDaemonSocketPath(directory),
      tokenPath: join(directory, 'daemon.token'),
      spawnSubprocess: async () => {
        subprocess = createMockSubprocess()
        markSpawnStarted()
        await spawnGate
        return subprocess
      }
    })
    await server.start()
    client = new DaemonClient({
      socketPath: getDaemonSocketPath(directory),
      tokenPath: join(directory, 'daemon.token')
    })
    await client.ensureConnected()
  })

  afterEach(async () => {
    releaseSpawn?.()
    client?.disconnect()
    await server?.shutdown()
    rmSync(directory, { recursive: true, force: true })
  })

  it.each(['cancelCreateOrAttach', 'kill'] as const)(
    'reaps a subprocess canceled by %s during async spawn',
    async (requestType) => {
      const create = client.request('createOrAttach', {
        sessionId: 'canceled-spawn',
        cols: 80,
        rows: 24
      })
      const canceled = expect(create).rejects.toThrow('Attach canceled for session canceled-spawn')
      await spawnStarted

      await (requestType === 'kill'
        ? client.request('kill', { sessionId: 'canceled-spawn', immediate: true })
        : client.request('cancelCreateOrAttach', { sessionId: 'canceled-spawn' }))
      releaseSpawn()
      await canceled

      expect(subprocess.forceKill).toHaveBeenCalledOnce()
      await expect(client.request('listSessions', undefined)).resolves.toEqual({ sessions: [] })
    }
  )

  it('reaps a subprocess after its requesting client disconnects', async () => {
    const create = client
      .request('createOrAttach', {
        sessionId: 'disconnected-spawn',
        cols: 80,
        rows: 24
      })
      .catch(() => undefined)
    await spawnStarted

    client.disconnect()
    const daemon = server as unknown as DaemonServerInternals
    await vi.waitFor(() =>
      expect([...(daemon.preparations.pending.get('disconnected-spawn') ?? [])][0]?.canceled).toBe(
        true
      )
    )
    releaseSpawn()
    await create
    await vi.waitFor(() => expect(subprocess.forceKill).toHaveBeenCalledOnce())
    expect(daemon.host.listSessions()).toEqual([])
  })

  it('reaps a subprocess after the client request times out', async () => {
    const create = client.request(
      'createOrAttach',
      { sessionId: 'timed-out-spawn', cols: 80, rows: 24 },
      10
    )
    await spawnStarted

    await expect(create).rejects.toThrow('timed out')
    releaseSpawn()

    await vi.waitFor(() => expect(subprocess.forceKill).toHaveBeenCalledOnce())
    await expect(client.request('listSessions', undefined)).resolves.toEqual({ sessions: [] })
  })

  it('reaps a subprocess after the client aborts its request', async () => {
    const abort = new AbortController()
    const create = client.request(
      'createOrAttach',
      { sessionId: 'aborted-spawn', cols: 80, rows: 24 },
      30_000,
      abort.signal
    )
    await spawnStarted

    abort.abort()
    await expect(create).rejects.toThrow('client_disconnected')
    releaseSpawn()

    await vi.waitFor(() => expect(subprocess.forceKill).toHaveBeenCalledOnce())
    await expect(client.request('listSessions', undefined)).resolves.toEqual({ sessions: [] })
  })

  it('matches a cancel for an attach-only request queued behind a hung create', async () => {
    const create = client.request('createOrAttach', {
      sessionId: 'shared-session',
      cols: 80,
      rows: 24
    })
    // Only queues behind the create once that create is actually in flight.
    await spawnStarted
    const abort = new AbortController()
    const attach = client.request(
      'createOrAttach',
      { sessionId: 'shared-session', cols: 80, rows: 24, attachOnly: true },
      30_000,
      abort.signal
    )
    const daemon = server as unknown as DaemonServerInternals
    // Attach-only used to register nothing, so the daemon could not match the
    // cancel and the client dropped its only timeout.
    await vi.waitFor(() => expect(daemon.preparations.pending.get('shared-session')?.size).toBe(2))

    abort.abort()
    await expect(attach).rejects.toThrow('client_disconnected')

    releaseSpawn()
    await expect(create).resolves.toMatchObject({ isNew: true })
  })

  it('does not cancel a sibling request for the same session id', async () => {
    const first = client.request('createOrAttach', {
      sessionId: 'shared-session',
      cols: 80,
      rows: 24
    })
    const abort = new AbortController()
    const second = client.request(
      'createOrAttach',
      { sessionId: 'shared-session', cols: 80, rows: 24 },
      30_000,
      abort.signal
    )
    await spawnStarted
    const daemon = server as unknown as DaemonServerInternals
    await vi.waitFor(() => expect(daemon.preparations.pending.get('shared-session')?.size).toBe(2))

    abort.abort()
    await expect(second).rejects.toThrow('client_disconnected')
    releaseSpawn()

    await expect(first).resolves.toMatchObject({ isNew: true })
    expect(subprocess.forceKill).not.toHaveBeenCalled()
    await expect(client.request('listSessions', undefined)).resolves.toMatchObject({
      sessions: [expect.objectContaining({ sessionId: 'shared-session' })]
    })
  })

  it('reaps an async spawn before daemon shutdown completes', async () => {
    const create = client
      .request('createOrAttach', {
        sessionId: 'shutdown-spawn',
        cols: 80,
        rows: 24
      })
      .catch(() => undefined)
    await spawnStarted

    const shutdown = server.shutdown()
    releaseSpawn()
    await create
    await shutdown

    expect(subprocess.forceKill).toHaveBeenCalledOnce()
    expect(subprocess.dispose).toHaveBeenCalledOnce()
  })
})
