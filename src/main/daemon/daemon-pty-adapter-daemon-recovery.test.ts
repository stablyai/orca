/* Dead-endpoint write handling and daemon respawn after the daemon dies. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { DaemonClient } from './client'
import { DaemonProtocolError } from './daemon-errors'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import type { DaemonFileLog } from './daemon-file-log'
import { PtyWriteUnavailableError } from '../providers/pty-write-unavailable-error'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'
import type * as DaemonHealthModule from './daemon-health'
import type * as DaemonTccAttributionModule from './daemon-tcc-attribution'
import type * as DaemonBundleStalenessModule from './daemon-bundle-staleness'

const {
  getMacDaemonSystemResolverHealthMock,
  getMacDaemonTccAttributionHealthMock,
  isDaemonStaleForCurrentBundleMock
} = vi.hoisted(() => ({
  getMacDaemonSystemResolverHealthMock: vi.fn(
    async (): Promise<'unknown' | 'unhealthy'> => 'unknown'
  ),
  getMacDaemonTccAttributionHealthMock: vi.fn(
    async (): Promise<'intact' | 'severed' | 'unknown'> => 'unknown'
  ),
  isDaemonStaleForCurrentBundleMock: vi.fn(async () => false)
}))

vi.mock('./daemon-health', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonHealthModule>()
  return {
    ...actual,
    getMacDaemonSystemResolverHealth: getMacDaemonSystemResolverHealthMock
  }
})

vi.mock('./daemon-tcc-attribution', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonTccAttributionModule>()
  return {
    ...actual,
    getMacDaemonTccAttributionHealth: getMacDaemonTccAttributionHealthMock
  }
})

vi.mock('./daemon-bundle-staleness', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonBundleStalenessModule>()
  return {
    ...actual,
    isDaemonStaleForCurrentBundle: isDaemonStaleForCurrentBundleMock
  }
})

describe('DaemonPtyAdapter (IPtyProvider)', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let lastSubprocess: ReturnType<typeof createMockSubprocess>
  let daemonLog: DaemonFileLog

  beforeEach(async () => {
    const harness = await startDaemonAdapterHarness(() => {
      lastSubprocess = createMockSubprocess()
      return lastSubprocess
    })
    dir = harness.dir
    socketPath = harness.socketPath
    tokenPath = harness.tokenPath
    server = harness.server
    adapter = harness.adapter
    daemonLog = harness.daemonLog
    getMacDaemonSystemResolverHealthMock.mockReset()
    getMacDaemonSystemResolverHealthMock.mockResolvedValue('unknown')
    getMacDaemonTccAttributionHealthMock.mockReset()
    getMacDaemonTccAttributionHealthMock.mockResolvedValue('unknown')
    isDaemonStaleForCurrentBundleMock.mockReset()
    isDaemonStaleForCurrentBundleMock.mockResolvedValue(false)
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('dead-endpoint write respawn (STA-2373)', () => {
    function restartServerOnRespawn(): void {
      server = new DaemonServer({
        socketPath,
        tokenPath,
        log: daemonLog,
        spawnSubprocess: () => {
          lastSubprocess = createMockSubprocess()
          return lastSubprocess
        }
      })
    }

    it('rejects stale input until createOrAttach remounts the pane onto the new daemon', async () => {
      let respawnServer: DaemonServer | undefined
      let respawnSubprocess: ReturnType<typeof createMockSubprocess> | undefined
      const respawn = vi.fn(async () => {
        respawnServer = new DaemonServer({
          socketPath,
          tokenPath,
          spawnSubprocess: () => {
            respawnSubprocess = createMockSubprocess()
            return respawnSubprocess
          }
        })
        await respawnServer.start()
      })
      const healingAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn })
      try {
        const { id } = await healingAdapter.spawn({ cols: 80, rows: 24 })
        const internals = healingAdapter as unknown as {
          sessionsAwaitingDaemonRecovery: Set<string>
        }

        await server.shutdown()
        await waitFor(() => internals.sessionsAwaitingDaemonRecovery.has(id))

        expect(() => healingAdapter.write(id, 'first')).toThrow(PtyWriteUnavailableError)
        expect(() => healingAdapter.write(id, 'second')).toThrow(PtyWriteUnavailableError)
        await waitFor(() => respawn.mock.calls.length === 1)

        expect(respawnSubprocess).toBeUndefined()
        expect(() => healingAdapter.write(id, 'still-stale')).toThrow(PtyWriteUnavailableError)

        await healingAdapter.spawn({ sessionId: id, cols: 80, rows: 24 })
        expect(() => healingAdapter.write(id, 'rebound')).not.toThrow()
        await waitFor(
          () =>
            respawnSubprocess !== undefined &&
            vi.mocked(respawnSubprocess.write).mock.calls.length === 1
        )
        expect(respawnSubprocess?.write).toHaveBeenCalledWith('rebound')
        expect(respawn).toHaveBeenCalledTimes(1)
      } finally {
        healingAdapter.dispose()
        await respawnServer?.shutdown()
      }
    })

    it('requires createOrAttach before writing to a session that survives a socket disconnect', async () => {
      const respawn = vi.fn(async () => {})
      const healingAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn })
      try {
        const { id } = await healingAdapter.spawn({ cols: 80, rows: 24 })
        const client = (healingAdapter as unknown as { client: DaemonClient }).client

        client.disconnect()
        expect(() => healingAdapter.write(id, 'stale')).toThrow(PtyWriteUnavailableError)
        await waitFor(() => client.isConnected())
        expect(() => healingAdapter.write(id, 'still-stale')).toThrow(PtyWriteUnavailableError)

        await healingAdapter.spawn({ sessionId: id, cols: 80, rows: 24 })
        healingAdapter.write(id, 'rebound')
        await waitFor(() => lastSubprocess.write.mock.calls.length > 0)
        expect(lastSubprocess.write.mock.calls).toEqual([['rebound']])
        expect(healingAdapter.hasPty(id)).toBe(true)
        expect(respawn).not.toHaveBeenCalled()
      } finally {
        healingAdapter.dispose()
      }
    })

    it('respawns after a retired daemon regardless of how the connection ended', async () => {
      // Why this shape: the daemon retires when its last authenticated client drops, and that drop
      // is often our own disconnect() — which observes no socket close. Once the token read stops
      // preempting the connect, the retired endpoint fails as a connect and isDaemonGoneError
      // classifies it, so recovery no longer depends on having witnessed the drop.
      let respawnServer: DaemonServer | undefined
      const respawn = vi.fn(async () => {
        respawnServer = new DaemonServer({
          socketPath,
          tokenPath,
          spawnSubprocess: () => createMockSubprocess()
        })
        await respawnServer.start()
      })
      const healingAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const { id } = await healingAdapter.spawn({ cols: 80, rows: 24 })
        const client = (healingAdapter as unknown as { client: DaemonClient }).client

        client.disconnect()
        await server.shutdown()
        expect(existsSync(tokenPath)).toBe(false)
        expect(client.hasObservedAuthenticatedDisconnect()).toBe(false)

        await expect(
          healingAdapter.spawn({ sessionId: id, cols: 80, rows: 24 })
        ).resolves.toMatchObject({ id })
        expect(respawn).toHaveBeenCalledTimes(1)
      } finally {
        warn.mockRestore()
        healingAdapter.dispose()
        await respawnServer?.shutdown()
      }
    })

    it('does not spawn a daemon per keystroke after respawn fails', async () => {
      const respawn = vi.fn(async () => {
        throw new Error('daemon unavailable')
      })
      const healingAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const { id } = await healingAdapter.spawn({ cols: 80, rows: 24 })
        const client = (healingAdapter as unknown as { client: DaemonClient }).client
        await server.shutdown()
        await waitFor(() => !client.isConnected())

        expect(() => healingAdapter.write(id, 'a')).toThrow(PtyWriteUnavailableError)
        await waitFor(() => respawn.mock.calls.length === 1)
        for (let i = 0; i < 100; i += 1) {
          expect(() => healingAdapter.write(id, 'b')).toThrow(PtyWriteUnavailableError)
        }

        expect(respawn).toHaveBeenCalledTimes(1)
      } finally {
        warn.mockRestore()
        healingAdapter.dispose()
      }
    })

    it('joins a request-path respawn instead of forking a second daemon', async () => {
      let releaseRespawn!: () => void
      const respawn = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          releaseRespawn = resolve
        })
        restartServerOnRespawn()
        await server.start()
      })
      const healingAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn })
      try {
        const { id } = await healingAdapter.spawn({ cols: 80, rows: 24 })
        const client = (healingAdapter as unknown as { client: DaemonClient }).client
        await server.shutdown()
        await waitFor(() => !client.isConnected())

        const newSpawn = healingAdapter.spawn({
          sessionId: 'request-path-session',
          cols: 80,
          rows: 24
        })
        await waitFor(() => releaseRespawn !== undefined)
        expect(() => healingAdapter.write(id, 'queued')).toThrow(PtyWriteUnavailableError)
        releaseRespawn()

        await expect(newSpawn).resolves.toMatchObject({ id: 'request-path-session' })
        expect(respawn).toHaveBeenCalledTimes(1)
      } finally {
        healingAdapter.dispose()
      }
    })

    it('does not respawn when a dropped write targets no active session', async () => {
      const respawn = vi.fn(async () => {
        restartServerOnRespawn()
        await server.start()
      })
      const idleAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn })
      try {
        const client = (idleAdapter as unknown as { client: DaemonClient }).client
        await idleAdapter.listProcesses()

        await server.shutdown()
        await waitFor(() => !client.isConnected())

        idleAdapter.write('never-attached-session', 'ls\n')

        await new Promise((r) => setTimeout(r, 50))
        expect(respawn).not.toHaveBeenCalled()
      } finally {
        idleAdapter.dispose()
      }
    })

    it('signals every active pane to recover when one pane hits the dead endpoint', async () => {
      const respawn = vi.fn(async () => {})
      const healingAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn })
      const recovered: string[] = []
      healingAdapter.onWriteUnavailable(({ id }) => recovered.push(id))
      try {
        const { id: a } = await healingAdapter.spawn({ sessionId: 'pane-a', cols: 80, rows: 24 })
        const { id: b } = await healingAdapter.spawn({ sessionId: 'pane-b', cols: 80, rows: 24 })
        const client = (healingAdapter as unknown as { client: DaemonClient }).client

        await server.shutdown()
        await waitFor(() => !client.isConnected())

        // Only pane A is written; pane B is a passive sibling the user never typed into.
        expect(() => healingAdapter.write(a, 'typed-into-a')).toThrow(PtyWriteUnavailableError)

        // Why revert-sensitive: a dead endpoint takes down EVERY session on the
        // daemon, so both panes must be told to remount + re-attach. Without the
        // fan-out, only the written pane (a) recovers and sibling b stays frozen
        // with silently dropped input (STA-2373 sibling-freeze regression).
        expect(recovered).toContain(a)
        expect(recovered).toContain(b)
      } finally {
        healingAdapter.dispose()
      }
    })

    it('keeps dropping writes silently on an adapter that cannot respawn', async () => {
      // Why revert-sensitive: legacy adapters are built with no respawn, so a remount
      // reattaches to nothing and rebuilds the pane EMPTY, losing scrollback the user
      // could still read. Rejecting the write is only an improvement where the endpoint
      // can actually come back, so an unrecoverable one must keep the old silent drop.
      const legacyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath })
      const recovered: string[] = []
      legacyAdapter.onWriteUnavailable(({ id }) => recovered.push(id))
      try {
        const { id } = await legacyAdapter.spawn({ sessionId: 'legacy-pane', cols: 80, rows: 24 })
        const client = (legacyAdapter as unknown as { client: DaemonClient }).client

        await server.shutdown()
        await waitFor(() => !client.isConnected())

        expect(() => legacyAdapter.write(id, 'typed')).not.toThrow()
        expect(recovered).toEqual([])
      } finally {
        legacyAdapter.dispose()
      }
    })

    it('re-arms recovery for a second daemon death when a background session never rebinds', async () => {
      const respawn = vi.fn(async () => {
        restartServerOnRespawn()
        await server.start()
      })
      const healingAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn })
      const recovered: string[] = []
      healingAdapter.onWriteUnavailable(({ id }) => recovered.push(id))
      try {
        await healingAdapter.spawn({ sessionId: 'pane-a', cols: 80, rows: 24 })
        // A backgrounded session: no pane is mounted for it, so nothing in the
        // renderer ever calls createOrAttach to rebind it after a daemon death.
        await healingAdapter.spawn({ sessionId: 'background-b', cols: 80, rows: 24 })
        const client = (healingAdapter as unknown as { client: DaemonClient }).client

        await server.shutdown()
        await waitFor(() => !client.isConnected())
        expect(() => healingAdapter.write('pane-a', 'first-death')).toThrow(
          PtyWriteUnavailableError
        )
        await waitFor(() => respawn.mock.calls.length === 1)
        await waitFor(() => client.isConnected())

        // Only the mounted pane rebinds; background-b keeps the awaiting set non-empty.
        await healingAdapter.spawn({ sessionId: 'pane-a', cols: 80, rows: 24 })
        recovered.length = 0

        await server.shutdown()
        await waitFor(() => !client.isConnected())

        // Why revert-sensitive: the storm latch is otherwise only released when the
        // awaiting set empties, which a never-rebinding background session prevents
        // forever. That silently downgrades the fix to one-shot — every daemon death
        // after the first would respawn nothing and leave siblings frozen again.
        expect(() => healingAdapter.write('pane-a', 'second-death')).toThrow(
          PtyWriteUnavailableError
        )
        expect(recovered).toContain('pane-a')
        await waitFor(() => respawn.mock.calls.length === 2)
      } finally {
        healingAdapter.dispose()
      }
    })
  })

  describe('respawn on daemon death', () => {
    it('respawns the daemon and retries when the socket disappears', async () => {
      let respawnServer: DaemonServer | undefined
      const respawnFn = vi.fn(async () => {
        respawnServer = new DaemonServer({
          socketPath,
          tokenPath,
          spawnSubprocess: () => createMockSubprocess()
        })
        await respawnServer.start()
      })

      const respawnAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn: respawnFn })

      // First spawn succeeds normally
      const r1 = await respawnAdapter.spawn({ cols: 80, rows: 24 })
      expect(r1.id).toBeDefined()

      // Kill the server to simulate daemon death
      await server.shutdown()

      // Next spawn should detect the dead socket, call respawn, and succeed
      const r2 = await respawnAdapter.spawn({ cols: 80, rows: 24 })
      expect(r2.id).toBeDefined()
      expect(respawnFn).toHaveBeenCalledTimes(1)
      expect(respawnFn).toHaveBeenCalledWith('daemon_died')

      respawnAdapter.dispose()
      await respawnServer?.shutdown()
    })

    it('propagates the error when no respawn callback is provided', async () => {
      const noRespawnAdapter = new DaemonPtyAdapter({ socketPath, tokenPath })

      // First spawn succeeds
      await noRespawnAdapter.spawn({ cols: 80, rows: 24 })

      // Kill the server
      await server.shutdown()

      // Next spawn should fail with the original socket error
      await expect(noRespawnAdapter.spawn({ cols: 80, rows: 24 })).rejects.toThrow()

      noRespawnAdapter.dispose()
    })

    it('treats a hello handshake timeout as daemon-gone and respawns (#8689)', async () => {
      // Why: a wedged daemon accepts the socket but never answers hello; classify as daemon-gone so withDaemonRetry respawns, else every spawn fails forever.
      const realEnsureConnected = DaemonClient.prototype.ensureConnected
      const ensureConnectedSpy = vi
        .spyOn(DaemonClient.prototype, 'ensureConnected')
        .mockImplementationOnce(async () => {
          // The exact error type + message the real client raises on a wedge.
          throw new DaemonProtocolError('Hello response timed out')
        })
        .mockImplementation(function (this: DaemonClient) {
          return realEnsureConnected.call(this)
        })
      const respawnFn = vi.fn(async () => {})
      const respawnAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn: respawnFn })

      try {
        const result = await respawnAdapter.spawn({ cols: 80, rows: 24 })
        expect(result.id).toBeDefined()
        expect(respawnFn).toHaveBeenCalledTimes(1)
        expect(respawnFn).toHaveBeenCalledWith('daemon_died')
      } finally {
        ensureConnectedSpy.mockRestore()
        respawnAdapter.dispose()
      }
    })

    it('coalesces concurrent respawns so only one daemon is forked', async () => {
      let respawnServer: DaemonServer | undefined
      const respawnFn = vi.fn(async () => {
        respawnServer = new DaemonServer({
          socketPath,
          tokenPath,
          spawnSubprocess: () => createMockSubprocess()
        })
        await respawnServer.start()
      })

      const respawnAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn: respawnFn })

      // First spawn connects
      await respawnAdapter.spawn({ cols: 80, rows: 24 })

      // Kill daemon
      await server.shutdown()

      // Fire two spawns concurrently — both should succeed but only one respawn
      const [r1, r2] = await Promise.all([
        respawnAdapter.spawn({ cols: 80, rows: 24 }),
        respawnAdapter.spawn({ cols: 80, rows: 24 })
      ])
      expect(r1.id).toBeDefined()
      expect(r2.id).toBeDefined()
      expect(respawnFn).toHaveBeenCalledTimes(1)
      expect(respawnFn).toHaveBeenCalledWith('daemon_died')

      respawnAdapter.dispose()
      await respawnServer?.shutdown()
    })

    it('preserves an unhealthy macOS resolver daemon when it owns live sessions', async () => {
      const respawnFn = vi.fn()
      const exits: { id: string; code: number }[] = []
      const respawnAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn: respawnFn })
      respawnAdapter.onExit((payload) => exits.push(payload))
      const existing = await respawnAdapter.spawn({ cols: 80, rows: 24 })
      getMacDaemonSystemResolverHealthMock.mockResolvedValueOnce('unhealthy')

      const next = await respawnAdapter.spawn({ cols: 80, rows: 24, isNewSession: true })

      expect(getMacDaemonSystemResolverHealthMock).toHaveBeenCalledWith(
        socketPath,
        tokenPath,
        respawnAdapter.protocolVersion
      )
      expect(respawnFn).not.toHaveBeenCalled()
      expect(exits).toEqual([])
      expect(next.id).toBeDefined()
      expect(next.id).not.toBe(existing.id)

      respawnAdapter.dispose()
    })

    it('preserves an unhealthy macOS resolver daemon when live sessions have not been reconciled locally', async () => {
      const respawnFn = vi.fn()
      const background = await adapter.spawn({ cols: 80, rows: 24 })
      const backgroundSubprocess = lastSubprocess
      const respawnAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn: respawnFn })
      getMacDaemonSystemResolverHealthMock.mockResolvedValueOnce('unhealthy')

      const next = await respawnAdapter.spawn({ cols: 80, rows: 24, isNewSession: true })

      expect(getMacDaemonSystemResolverHealthMock).toHaveBeenCalledWith(
        socketPath,
        tokenPath,
        respawnAdapter.protocolVersion
      )
      expect(respawnFn).not.toHaveBeenCalled()
      expect(next.id).toBeDefined()
      expect(next.id).not.toBe(background.id)
      expect(backgroundSubprocess.forceKill).not.toHaveBeenCalled()

      respawnAdapter.dispose()
    })

    it('replaces an unhealthy macOS resolver daemon before creating a fresh session when no sessions are active', async () => {
      let respawnServer: DaemonServer | undefined
      const respawnFn = vi.fn(async () => {
        await server.shutdown()
        rmSync(socketPath, { force: true })
        respawnServer = new DaemonServer({
          socketPath,
          tokenPath,
          spawnSubprocess: () => createMockSubprocess()
        })
        await respawnServer.start()
      })
      const exits: { id: string; code: number }[] = []
      const respawnAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn: respawnFn })
      respawnAdapter.onExit((payload) => exits.push(payload))
      getMacDaemonSystemResolverHealthMock.mockResolvedValueOnce('unhealthy')

      const replacement = await respawnAdapter.spawn({ cols: 80, rows: 24, isNewSession: true })

      expect(getMacDaemonSystemResolverHealthMock).toHaveBeenCalledWith(
        socketPath,
        tokenPath,
        respawnAdapter.protocolVersion
      )
      expect(respawnFn).toHaveBeenCalledTimes(1)
      expect(respawnFn).toHaveBeenCalledWith('unhealthy_resolver')
      expect(exits).toEqual([])
      expect(replacement.id).toBeDefined()

      respawnAdapter.dispose()
      await respawnServer?.shutdown()
    })

    it('does not resolver-health restart attach-style spawns', async () => {
      const respawnFn = vi.fn()
      const respawnAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn: respawnFn })
      getMacDaemonSystemResolverHealthMock.mockResolvedValueOnce('unhealthy')

      const result = await respawnAdapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'caller-owned-session'
      })

      expect(result.id).toBe('caller-owned-session')
      expect(getMacDaemonSystemResolverHealthMock).not.toHaveBeenCalled()
      expect(respawnFn).not.toHaveBeenCalled()

      respawnAdapter.dispose()
    })

    it('preserves a stale packaged daemon that still owns live sessions before a new spawn', async () => {
      const respawnFn = vi.fn()
      const respawnAdapter = new DaemonPtyAdapter({
        socketPath,
        tokenPath,
        runtimeDir: dir,
        packagedAppVersion: '1.4.178',
        respawn: respawnFn
      })
      await respawnAdapter.spawn({ cols: 80, rows: 24, isNewSession: true })
      isDaemonStaleForCurrentBundleMock.mockResolvedValueOnce(true)

      const next = await respawnAdapter.spawn({ cols: 80, rows: 24, isNewSession: true })

      expect(isDaemonStaleForCurrentBundleMock).toHaveBeenCalledWith(
        dir,
        socketPath,
        tokenPath,
        '1.4.178',
        respawnAdapter.protocolVersion
      )
      expect(respawnFn).not.toHaveBeenCalled()
      expect(next.id).toBeDefined()

      respawnAdapter.dispose()
    })

    it('preserves a stale packaged daemon when its live session inventory is unavailable', async () => {
      const respawnFn = vi.fn()
      const respawnAdapter = new DaemonPtyAdapter({
        socketPath,
        tokenPath,
        runtimeDir: dir,
        packagedAppVersion: '1.4.178',
        respawn: respawnFn
      })
      const internals = respawnAdapter as unknown as {
        client: { request: (type: string, payload?: unknown) => Promise<unknown> }
      }
      const originalRequest = internals.client.request.bind(internals.client)
      vi.spyOn(internals.client, 'request').mockImplementation((type, payload) => {
        if (type === 'listSessions') {
          return Promise.reject(new Error('inventory unavailable'))
        }
        return originalRequest(type, payload)
      })
      isDaemonStaleForCurrentBundleMock.mockResolvedValueOnce(true)

      const next = await respawnAdapter.spawn({ cols: 80, rows: 24, isNewSession: true })

      expect(respawnFn).not.toHaveBeenCalled()
      expect(next.id).toBeDefined()

      respawnAdapter.dispose()
    })

    it('coalesces stale-bundle retirement before concurrent fresh sessions', async () => {
      let respawnServer: DaemonServer | undefined
      const respawnFn = vi.fn(async () => {
        await server.shutdown()
        rmSync(socketPath, { force: true })
        respawnServer = new DaemonServer({
          socketPath,
          tokenPath,
          spawnSubprocess: () => createMockSubprocess()
        })
        await respawnServer.start()
      })
      const respawnAdapter = new DaemonPtyAdapter({
        socketPath,
        tokenPath,
        runtimeDir: dir,
        packagedAppVersion: '1.4.178',
        respawn: respawnFn
      })
      isDaemonStaleForCurrentBundleMock.mockResolvedValue(true)

      const replacements = await Promise.all([
        respawnAdapter.spawn({ cols: 80, rows: 24, isNewSession: true }),
        respawnAdapter.spawn({ cols: 80, rows: 24, isNewSession: true })
      ])

      expect(respawnFn).toHaveBeenCalledTimes(1)
      expect(respawnFn).toHaveBeenCalledWith('stale_bundle')
      expect(replacements.every((replacement) => replacement.id)).toBe(true)

      respawnAdapter.dispose()
      await respawnServer?.shutdown()
    })

    it('preserves a severed-TCC daemon that still owns live sessions before a new spawn', async () => {
      const respawnFn = vi.fn()
      const respawnAdapter = new DaemonPtyAdapter({
        socketPath,
        tokenPath,
        runtimeDir: dir,
        respawn: respawnFn
      })
      // One live session in this adapter — the zero-session gate must fail closed.
      await respawnAdapter.spawn({ cols: 80, rows: 24, isNewSession: true })
      getMacDaemonTccAttributionHealthMock.mockResolvedValueOnce('severed')

      const next = await respawnAdapter.spawn({ cols: 80, rows: 24, isNewSession: true })

      expect(getMacDaemonTccAttributionHealthMock).toHaveBeenCalledWith(
        dir,
        socketPath,
        tokenPath,
        respawnAdapter.protocolVersion
      )
      expect(respawnFn).not.toHaveBeenCalled()
      expect(next.id).toBeDefined()

      respawnAdapter.dispose()
    })

    it('preserves a severed-TCC daemon when its live session inventory is unavailable', async () => {
      const respawnFn = vi.fn()
      const respawnAdapter = new DaemonPtyAdapter({
        socketPath,
        tokenPath,
        runtimeDir: dir,
        respawn: respawnFn
      })
      const internals = respawnAdapter as unknown as {
        client: { request: (type: string, payload?: unknown) => Promise<unknown> }
      }
      const originalRequest = internals.client.request.bind(internals.client)
      vi.spyOn(internals.client, 'request').mockImplementation((type, payload) => {
        if (type === 'listSessions') {
          return Promise.reject(new Error('inventory unavailable'))
        }
        return originalRequest(type, payload)
      })
      getMacDaemonTccAttributionHealthMock.mockResolvedValueOnce('severed')

      const next = await respawnAdapter.spawn({ cols: 80, rows: 24, isNewSession: true })

      expect(respawnFn).not.toHaveBeenCalled()
      expect(next.id).toBeDefined()

      respawnAdapter.dispose()
    })

    it('replaces a severed-TCC daemon before a fresh session when no sessions are active', async () => {
      let respawnServer: DaemonServer | undefined
      const respawnFn = vi.fn(async () => {
        await server.shutdown()
        rmSync(socketPath, { force: true })
        respawnServer = new DaemonServer({
          socketPath,
          tokenPath,
          spawnSubprocess: () => createMockSubprocess()
        })
        await respawnServer.start()
      })
      const respawnAdapter = new DaemonPtyAdapter({
        socketPath,
        tokenPath,
        runtimeDir: dir,
        respawn: respawnFn
      })
      getMacDaemonTccAttributionHealthMock.mockResolvedValueOnce('severed')

      const replacement = await respawnAdapter.spawn({ cols: 80, rows: 24, isNewSession: true })

      expect(getMacDaemonTccAttributionHealthMock).toHaveBeenCalledWith(
        dir,
        socketPath,
        tokenPath,
        respawnAdapter.protocolVersion
      )
      expect(respawnFn).toHaveBeenCalledTimes(1)
      expect(respawnFn).toHaveBeenCalledWith('severed_tcc_attribution')
      expect(replacement.id).toBeDefined()

      respawnAdapter.dispose()
      await respawnServer?.shutdown()
    })

    it('propagates respawn failure to the caller', async () => {
      const respawnFn = vi.fn(async () => {
        throw new Error('Daemon entry file missing')
      })

      const respawnAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn: respawnFn })
      await respawnAdapter.spawn({ cols: 80, rows: 24 })
      await server.shutdown()

      await expect(respawnAdapter.spawn({ cols: 80, rows: 24 })).rejects.toThrow(
        'Daemon entry file missing'
      )

      respawnAdapter.dispose()
    })
  })
})
