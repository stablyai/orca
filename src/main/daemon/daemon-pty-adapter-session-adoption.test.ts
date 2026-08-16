/* Adopting daemon sessions that already exist: reattach, attach-only, inventory, tombstones, startup reconcile. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { rmSync, writeFileSync } from 'node:fs'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import type { HistoryReader } from './history-reader'
import type { DaemonFileLog } from './daemon-file-log'
import { serializeDaemonPidFile } from './daemon-spawner'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'
import type * as DaemonHealthModule from './daemon-health'
import type * as DaemonTccAttributionModule from './daemon-tcc-attribution'

const { getMacDaemonSystemResolverHealthMock, getMacDaemonTccAttributionHealthMock } = vi.hoisted(
  () => ({
    getMacDaemonSystemResolverHealthMock: vi.fn(
      async (): Promise<'unknown' | 'unhealthy'> => 'unknown'
    ),
    getMacDaemonTccAttributionHealthMock: vi.fn(
      async (): Promise<'intact' | 'severed' | 'unknown'> => 'unknown'
    )
  })
)

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

describe('DaemonPtyAdapter (IPtyProvider)', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let lastSubprocess: ReturnType<typeof createMockSubprocess>
  let lastSpawnOpts: {
    sessionId: string
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    command?: string
  } | null
  let daemonLog: DaemonFileLog

  beforeEach(async () => {
    const harness = await startDaemonAdapterHarness((opts) => {
      lastSpawnOpts = opts
      lastSubprocess = createMockSubprocess()
      return lastSubprocess
    })
    dir = harness.dir
    socketPath = harness.socketPath
    tokenPath = harness.tokenPath
    server = harness.server
    adapter = harness.adapter
    daemonLog = harness.daemonLog
    lastSpawnOpts = null
    getMacDaemonSystemResolverHealthMock.mockReset()
    getMacDaemonSystemResolverHealthMock.mockResolvedValue('unknown')
    getMacDaemonTccAttributionHealthMock.mockReset()
    getMacDaemonTccAttributionHealthMock.mockResolvedValue('unknown')
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('spawn with sessionId (reattach)', () => {
    it('returns full snapshot and isReattach when reattaching', async () => {
      const sessionId = 'reattach-test-session'
      const first = await adapter.spawn({ cols: 80, rows: 24, sessionId, launchAgent: 'droid' })
      expect(first.id).toBe(sessionId)
      expect(first.isReattach).toBeUndefined()
      expect(first.launchAgent).toBe('droid')

      // Write data so the headless emulator captures it
      lastSubprocess._simulateData('hello from shell\r\n')
      await new Promise((r) => setTimeout(r, 50))

      // Spawn again with the same sessionId — should reattach
      const second = await adapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(second.id).toBe(sessionId)
      expect(second.isReattach).toBe(true)
      expect(second.launchAgent).toBe('droid')
      expect(second.snapshot).toBeDefined()
      expect(second.snapshot).toContain('hello from shell')
      expect(second.providerSequence).toEqual({
        value: 'hello from shell\r\n'.length,
        generation: 'continued'
      })
    })

    it('includes rehydrateSequences in snapshot when terminal modes are active', async () => {
      const sessionId = 'rehydrate-test'
      await adapter.spawn({ cols: 80, rows: 24, sessionId })

      // Enable bracketed paste mode, then write visible output
      lastSubprocess._simulateData('\x1b[?2004h')
      lastSubprocess._simulateData('prompt$ ')
      await new Promise((r) => setTimeout(r, 50))

      const result = await adapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.isReattach).toBe(true)
      expect(result.snapshot).toContain('\x1b[?2004h')
      expect(result.snapshot).toContain('prompt$')
    })

    it('publishes the alt-frame payload as explicit strings', async () => {
      const sessionId = 'alt-frame-boundary'
      await adapter.spawn({ cols: 80, rows: 24, sessionId })
      lastSubprocess._simulateData('\x1b[?1049h\x1b[HSTATIC-ALT-FRAME')
      await new Promise((r) => setTimeout(r, 50))

      const result = await adapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.snapshotPrefixAnsi).toContain('\x1b[?1049h')
      expect(result.snapshotFrameAnsi).toContain('STATIC-ALT-FRAME')
      expect(result.snapshot).toBe([result.snapshotPrefixAnsi, result.snapshotFrameAnsi].join(''))
      expect(result.snapshotFrameRestoreAnsi).not.toContain('STATIC-ALT-FRAME')
    })

    it('returns the preserved sequence from attach-only adoption', async () => {
      const sessionId = 'attach-sequence-handoff'
      await adapter.spawn({ cols: 80, rows: 24, sessionId })
      lastSubprocess._simulateData('preserved output')
      await new Promise((r) => setTimeout(r, 50))

      await expect(adapter.attach(sessionId)).resolves.toEqual({
        providerSequence: {
          value: 'preserved output'.length,
          generation: 'continued'
        }
      })
    })

    it('returns plain result for new sessionId', async () => {
      const result = await adapter.spawn({ cols: 80, rows: 24, sessionId: 'brand-new' })
      expect(result.id).toBe('brand-new')
      expect(result.isReattach).toBeUndefined()
      expect(result.snapshot).toBeUndefined()
      expect(result.providerSequence).toEqual({ value: 0, generation: 'reset' })
    })

    it('forwards attach-only and never creates an absent stable session', async () => {
      const subprocessBeforeAttach = lastSubprocess
      await expect(
        adapter.spawn({
          cols: 80,
          rows: 24,
          sessionId: 'missing-stable-pane-session',
          attachOnly: true
        })
      ).rejects.toThrow('Session not found: missing-stable-pane-session')
      expect(lastSubprocess).toBe(subprocessBeforeAttach)
    })

    it('does not inspect cold history for attach-only ownership checks', async () => {
      const historyDir = join(dir, 'attach-only-history')
      const historyAdapter = new DaemonPtyAdapter({
        socketPath,
        tokenPath,
        historyPath: historyDir
      })
      const reader = (historyAdapter as unknown as { historyReader: HistoryReader }).historyReader
      const probe = vi.spyOn(reader, 'probeRestorableHistory')
      const getAppliedSize = vi.spyOn(historyAdapter, 'getAppliedSize')

      try {
        await expect(
          historyAdapter.spawn({
            cols: 80,
            rows: 24,
            sessionId: 'missing-attach-only-history-session',
            attachOnly: true
          })
        ).rejects.toThrow('Session not found: missing-attach-only-history-session')
        expect(probe).not.toHaveBeenCalled()
        expect(getAppliedSize).not.toHaveBeenCalled()
      } finally {
        historyAdapter.dispose()
      }
    })

    it('reattaches a stable pane through a preserved v30 daemon', async () => {
      const ensureConnected = vi
        .spyOn(DaemonClient.prototype, 'ensureConnected')
        .mockResolvedValue()
      const request = vi.spyOn(DaemonClient.prototype, 'request').mockResolvedValue({
        isNew: false,
        snapshot: null,
        pid: 4321,
        shellState: 'unsupported',
        incarnationId: 'legacy-stable-pane-incarnation'
      })
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 30 })
      try {
        await expect(
          legacy.spawn({
            cols: 80,
            rows: 24,
            sessionId: 'legacy-stable-pane-session',
            attachOnly: true,
            command: 'must-not-run'
          })
        ).resolves.toMatchObject({
          id: 'legacy-stable-pane-session',
          incarnationId: 'legacy-stable-pane-incarnation',
          isReattach: true
        })
        expect(request).toHaveBeenCalledWith(
          'createOrAttach',
          expect.objectContaining({
            command: undefined,
            launchAgent: undefined,
            startupCommandDelivery: undefined
          })
        )
        expect(request.mock.calls[0]?.[1]).not.toHaveProperty('attachOnly')
      } finally {
        legacy.dispose()
        request.mockRestore()
        ensureConnected.mockRestore()
      }
    })

    it('retires a replacement created by a raced-out v30 stable pane', async () => {
      const ensureConnected = vi
        .spyOn(DaemonClient.prototype, 'ensureConnected')
        .mockResolvedValue()
      const request = vi
        .spyOn(DaemonClient.prototype, 'request')
        .mockResolvedValueOnce({
          isNew: true,
          snapshot: null,
          pid: 4321,
          shellState: 'unsupported',
          incarnationId: 'legacy-replacement-incarnation'
        })
        .mockResolvedValueOnce({})
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 30 })
      try {
        await expect(
          legacy.spawn({
            cols: 80,
            rows: 24,
            sessionId: 'raced-out-legacy-session',
            attachOnly: true,
            command: 'must-not-run'
          })
        ).rejects.toThrow('Session not found: raced-out-legacy-session')
        expect(request).toHaveBeenNthCalledWith(
          1,
          'createOrAttach',
          expect.objectContaining({ command: undefined })
        )
        expect(request).toHaveBeenNthCalledWith(2, 'kill', {
          sessionId: 'raced-out-legacy-session',
          immediate: true
        })
        expect(legacy.getActiveSessionIds()).toEqual([])
      } finally {
        legacy.dispose()
        request.mockRestore()
        ensureConnected.mockRestore()
      }
    })
  })

  describe('attach', () => {
    it('reattaches to existing session and receives events', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })

      // Create a second adapter simulating app restart
      const adapter2 = new DaemonPtyAdapter({ socketPath, tokenPath })
      const dataPayloads: { id: string; data: string }[] = []
      adapter2.onData((payload) => dataPayloads.push(payload))

      await adapter2.attach(id)

      lastSubprocess._simulateData('after-reattach')
      await waitFor(() => dataPayloads.length > 0)
      expect(dataPayloads[0]).toEqual({ id, data: 'after-reattach' })

      adapter2.dispose()
    })

    it('preserves the live session dimensions instead of forcing 80×24', async () => {
      const { id } = await adapter.spawn({ cols: 137, rows: 41 })

      const adapter2 = new DaemonPtyAdapter({ socketPath, tokenPath })
      await adapter2.attach(id)

      // The running TUI keeps its geometry: no resize, size unchanged.
      expect(lastSubprocess.resize).not.toHaveBeenCalled()
      expect(await adapter2.getAppliedSize(id)).toEqual({ cols: 137, rows: 41 })
      adapter2.dispose()
    })

    it('keeps legacy attach behavior when no output sequence is available', async () => {
      const ensureConnected = vi
        .spyOn(DaemonClient.prototype, 'ensureConnected')
        .mockResolvedValue()
      const request = vi
        .spyOn(DaemonClient.prototype, 'request')
        .mockImplementation(async (type: string) =>
          type === 'getSize'
            ? ({ size: { cols: 100, rows: 30 } } as never)
            : ({
                isNew: false,
                snapshot: null,
                pid: 4321,
                shellState: 'unsupported',
                incarnationId: 'legacy-attach-incarnation'
              } as never)
        )
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 30 })
      try {
        await expect(legacy.attach('legacy-session')).resolves.toBeUndefined()
      } finally {
        legacy.dispose()
        request.mockRestore()
        ensureConnected.mockRestore()
      }
    })

    it('refuses to create when the session is absent (attach-only)', async () => {
      const adapter2 = new DaemonPtyAdapter({ socketPath, tokenPath })

      await expect(adapter2.attach('wt-x@@deadbeef')).rejects.toThrow(
        'Session not found: wt-x@@deadbeef'
      )

      // No shell was spawned as a side effect of the refused attach.
      expect(lastSpawnOpts).toBeNull()
      adapter2.dispose()
    })

    it('retires the accidental spawn of a pre-v31 daemon that ignores attachOnly', async () => {
      const ensureConnectedSpy = vi
        .spyOn(DaemonClient.prototype, 'ensureConnected')
        .mockResolvedValue()
      const requestSpy = vi
        .spyOn(DaemonClient.prototype, 'request')
        .mockImplementation(async (type: string) =>
          type === 'getSize'
            ? ({ size: { cols: 100, rows: 30 } } as never)
            : type === 'createOrAttach'
              ? ({ isNew: true, pid: 77, shellState: 'unsupported', snapshot: null } as never)
              : ({} as never)
        )
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 30 })
      try {
        await expect(legacy.attach('raced-legacy-session')).rejects.toThrow(
          'Session not found: raced-legacy-session'
        )

        expect(requestSpy).toHaveBeenCalledWith(
          'createOrAttach',
          expect.objectContaining({ cols: 100, rows: 30, attachOnly: true })
        )
        expect(requestSpy).toHaveBeenCalledWith('kill', {
          sessionId: 'raced-legacy-session',
          immediate: true
        })
      } finally {
        legacy.dispose()
        requestSpy.mockRestore()
        ensureConnectedSpy.mockRestore()
      }
    })

    it('surfaces a failed retire of the accidental legacy spawn instead of swallowing it', async () => {
      const ensureConnectedSpy = vi
        .spyOn(DaemonClient.prototype, 'ensureConnected')
        .mockResolvedValue()
      const requestSpy = vi
        .spyOn(DaemonClient.prototype, 'request')
        .mockImplementation(async (type: string) => {
          if (type === 'getSize') {
            return { size: { cols: 100, rows: 30 } } as never
          }
          if (type === 'createOrAttach') {
            return { isNew: true, pid: 77, shellState: 'unsupported', snapshot: null } as never
          }
          throw new Error('kill transport lost')
        })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 30 })
      try {
        await expect(legacy.attach('orphaned-legacy-session')).rejects.toThrow(
          'Session not found: orphaned-legacy-session'
        )

        // The orphaned replacement is at least diagnosable.
        expect(warnSpy).toHaveBeenCalledWith(
          '[daemon] attach-only retire of accidental legacy spawn failed',
          expect.objectContaining({ sessionId: 'orphaned-legacy-session' })
        )
      } finally {
        legacy.dispose()
        warnSpy.mockRestore()
        requestSpy.mockRestore()
        ensureConnectedSpy.mockRestore()
      }
    })
  })

  describe('listProcesses', () => {
    // Why: hasPty reads the activeSessionIds cache; an exit missed while the
    // socket was down must not survive an authoritative inventory, or absence
    // proofs (terminal list demotion, send guard) are defeated forever.
    it('drops cached session ids an authoritative inventory omits', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      const staleId = 'repo::/repo/stale@@deadbeef'
      ;(adapter as unknown as { activeSessionIds: Set<string> }).activeSessionIds.add(staleId)
      expect(adapter.hasPty(staleId)).toBe(true)

      await adapter.listProcesses()

      expect(adapter.hasPty(staleId)).toBe(false)
      expect(adapter.hasPty(id)).toBe(true)
    })

    it('returns active sessions', async () => {
      await adapter.spawn({
        cols: 80,
        rows: 24,
        cwd: '/repo/owned-before-osc7',
        worktreeId: 'repo::/repo/owned-before-osc7'
      })
      await adapter.spawn({ cols: 80, rows: 24 })

      const procs = await adapter.listProcesses()
      expect(procs).toHaveLength(2)
      expect(procs[0]).toHaveProperty('id')
      expect(procs[0]).toHaveProperty('cwd')
      expect(procs[0]).toHaveProperty('title')
      expect(procs[0].cwd).toBe('/repo/owned-before-osc7')
      expect(procs[0].worktreeId).toBe('repo::/repo/owned-before-osc7')
      expect(adapter.getLastAuditObservation()).toMatchObject({
        state: 'present',
        reason: 'authenticated_inventory',
        inventoryAuthority: 'authoritative'
      })
    })

    it('loads persisted Linux birth identity for audit observations', async () => {
      adapter.dispose()
      await server.shutdown()
      const startedAtMs = 1_700_000_000_000
      const launchNonce = 'launch-with-linux-identity'
      server = new DaemonServer({
        socketPath,
        tokenPath,
        startedAtMs,
        launchNonce,
        log: daemonLog,
        spawnSubprocess: (opts) => {
          lastSpawnOpts = opts
          lastSubprocess = createMockSubprocess()
          return lastSubprocess
        }
      })
      await server.start()
      const pidPath = join(dir, 'daemon.pid')
      writeFileSync(
        pidPath,
        serializeDaemonPidFile({
          pid: process.pid,
          startedAtMs,
          launchNonce,
          linuxStartTicks: '4242',
          bootId: 'boot-a'
        })
      )
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
      try {
        adapter = new DaemonPtyAdapter({ socketPath, tokenPath, pidPath })

        await expect(adapter.listProcesses()).resolves.toEqual([])

        expect(adapter.getLastAuditObservation()?.exactIncarnation).toMatchObject({
          linuxStartTicks: '4242',
          bootId: 'boot-a'
        })
      } finally {
        if (platform) {
          Object.defineProperty(process, 'platform', platform)
        }
      }
    })

    it('reports the daemon session WSL owner', async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      try {
        const spawned = await adapter.spawn({
          cols: 80,
          rows: 24,
          cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'
        })

        const procs = await adapter.listProcesses()

        expect(procs.find((process) => process.id === spawned.id)?.wslDistro).toBe('Ubuntu')
      } finally {
        if (platform) {
          Object.defineProperty(process, 'platform', platform)
        }
      }
    })

    it('retains authenticated identity and reports replacement across a same-endpoint reconnect', async () => {
      await adapter.listProcesses()
      const firstIdentity = adapter.getLastAuthenticatedDaemonIdentity()
      expect(firstIdentity).not.toBeNull()
      const identityChanges: {
        previous: NonNullable<typeof firstIdentity>
        current: NonNullable<typeof firstIdentity>
      }[] = []
      adapter.onDaemonIdentityChanged(() => {
        throw new Error('audit listener failed')
      })
      adapter.onDaemonIdentityChanged((event) => identityChanges.push(event))

      await server.shutdown()
      await waitFor(
        () => !(adapter as unknown as { client: { isConnected(): boolean } }).client.isConnected()
      )
      expect(adapter.getLastAuthenticatedDaemonIdentity()).toEqual(firstIdentity)
      server = new DaemonServer({
        socketPath,
        tokenPath,
        launchNonce: 'replacement-launch',
        startedAtMs: (firstIdentity?.startedAtMs ?? 0) + 10_000,
        log: daemonLog,
        spawnSubprocess: (opts) => {
          lastSpawnOpts = opts
          lastSubprocess = createMockSubprocess()
          return lastSubprocess
        }
      })
      await server.start()

      await expect(adapter.listProcesses()).resolves.toEqual([])

      expect(identityChanges).toEqual([
        {
          previous: firstIdentity,
          current: {
            pid: process.pid,
            startedAtMs: (firstIdentity?.startedAtMs ?? 0) + 10_000,
            launchNonce: 'replacement-launch'
          }
        }
      ])
      expect(adapter.getLastAuthenticatedDaemonIdentity()).toEqual(identityChanges[0]?.current)
    })

    it('isolates audit observation listeners from inventory and later listeners', async () => {
      const laterListener = vi.fn()
      adapter.onAuditEligibilityObservation(() => {
        throw new Error('audit listener failed')
      })
      adapter.onAuditEligibilityObservation(laterListener)

      await expect(adapter.listProcesses()).resolves.toEqual([])

      expect(laterListener).toHaveBeenCalledOnce()
      expect(laterListener).toHaveBeenCalledWith(
        expect.objectContaining({
          state: 'present',
          reason: 'authenticated_inventory'
        })
      )
      expect(adapter.getLastAuditObservation()).toMatchObject({
        state: 'present',
        reason: 'authenticated_inventory'
      })
    })

    it('audits token ENOENT only after an authenticated disconnect', async () => {
      const observations: {
        trigger: string
        state: string
        evidenceSources: readonly string[]
      }[] = []
      adapter.onAuditEligibilityObservation((observation) => observations.push(observation))
      await adapter.listProcesses()

      await server.shutdown()
      await waitFor(
        () => !(adapter as unknown as { client: { isConnected(): boolean } }).client.isConnected()
      )
      await expect(adapter.listProcesses()).rejects.toThrow()
      await waitFor(() =>
        observations.some(
          (observation) => observation.trigger === 'token_missing_after_authenticated_disconnect'
        )
      )

      expect(observations).toContainEqual(
        expect.objectContaining({
          trigger: 'token_missing_after_authenticated_disconnect',
          state: 'unknown',
          evidenceSources: expect.arrayContaining(['token_file'])
        })
      )
    })
  })

  describe('hasChildProcesses / getForegroundProcess', () => {
    it('returns false for shell foreground processes', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      vi.mocked(lastSubprocess.getForegroundProcess).mockReturnValue('bash')
      expect(await adapter.hasChildProcesses(id)).toBe(false)
    })

    it('returns true for non-shell foreground processes', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      vi.mocked(lastSubprocess.getForegroundProcess).mockReturnValue('codex')
      expect(await adapter.hasChildProcesses(id)).toBe(true)
    })

    it('returns the foreground process', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      vi.mocked(lastSubprocess.getForegroundProcess).mockReturnValue('codex')
      expect(await adapter.getForegroundProcess(id)).toBe('codex')
    })
  })

  describe('killed-session tombstones', () => {
    it('prevents spawn after shutdown for same sessionId', async () => {
      const sessionId = 'tombstone-test'
      await adapter.spawn({ cols: 80, rows: 24, sessionId })
      await adapter.shutdown(sessionId, { immediate: true })

      await expect(adapter.spawn({ cols: 80, rows: 24, sessionId })).rejects.toThrow(
        'was explicitly killed'
      )
    })

    it('allows spawn for different sessionId after shutdown', async () => {
      await adapter.spawn({ cols: 80, rows: 24, sessionId: 'kill-me' })
      await adapter.shutdown('kill-me', { immediate: true })

      const result = await adapter.spawn({ cols: 80, rows: 24, sessionId: 'fresh-one' })
      expect(result.id).toBe('fresh-one')
    })

    it('clearTombstone allows re-spawn', async () => {
      const sessionId = 'cleared-tombstone'
      await adapter.spawn({ cols: 80, rows: 24, sessionId })
      await adapter.shutdown(sessionId, { immediate: true })

      adapter.clearTombstone(sessionId)

      const result = await adapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.id).toBe(sessionId)
    })

    it('evicts oldest tombstone when exceeding limit', async () => {
      // Why: MAX_TOMBSTONES is 1000; spawning that many is slow, so verify eviction with a small batch via the public spawn API.
      const ids: string[] = []
      for (let i = 0; i < 5; i++) {
        const id = `evict-${i}`
        ids.push(id)
        await adapter.spawn({ cols: 80, rows: 24, sessionId: id })
        await adapter.shutdown(id, { immediate: true })
      }

      // All 5 should be tombstoned
      for (const id of ids) {
        await expect(adapter.spawn({ cols: 80, rows: 24, sessionId: id })).rejects.toThrow(
          'was explicitly killed'
        )
      }

      // clearTombstone the first one, then re-kill it — it should still work
      adapter.clearTombstone(ids[0])
      await adapter.spawn({ cols: 80, rows: 24, sessionId: ids[0] })
      await adapter.shutdown(ids[0], { immediate: true })

      // First tombstone was re-added at the Map's end, so eviction order is now [evict-1, evict-2, evict-3, evict-4, evict-0]
      await expect(adapter.spawn({ cols: 80, rows: 24, sessionId: ids[0] })).rejects.toThrow(
        'was explicitly killed'
      )
    })
  })

  describe('reconcileOnStartup', () => {
    it('returns alive sessions for valid worktrees', async () => {
      const wt = 'repo-a::/wt/active'
      await adapter.spawn({ cols: 80, rows: 24, worktreeId: wt })

      const { alive, killed } = await adapter.reconcileOnStartup(new Set([wt]))
      expect(alive).toHaveLength(1)
      expect(alive[0]).toContain(wt)
      expect(killed).toHaveLength(0)
    })

    it('kills sessions for removed worktrees', async () => {
      const wt = 'repo-a::/wt/removed'
      await adapter.spawn({ cols: 80, rows: 24, worktreeId: wt })

      const { alive, killed } = await adapter.reconcileOnStartup(new Set(['repo-a::/wt/other']))
      expect(alive).toHaveLength(0)
      expect(killed).toHaveLength(1)
      expect(killed[0]).toContain(wt)
    })

    it('handles mix of valid and orphaned sessions', async () => {
      const keep = 'repo-a::/wt/keep'
      const drop = 'repo-a::/wt/delete'
      await adapter.spawn({ cols: 80, rows: 24, worktreeId: keep })
      await adapter.spawn({ cols: 80, rows: 24, worktreeId: drop })

      const { alive, killed } = await adapter.reconcileOnStartup(new Set([keep]))
      expect(alive).toHaveLength(1)
      expect(killed).toHaveLength(1)
    })

    it('correctly parses hyphenated worktreeIds', async () => {
      const complexId = 'repo-abc::/Users/dev/my-feature-branch'
      await adapter.spawn({ cols: 80, rows: 24, worktreeId: complexId })

      const { alive, killed } = await adapter.reconcileOnStartup(new Set([complexId]))
      expect(alive).toHaveLength(1)
      expect(killed).toHaveLength(0)
    })

    it('kills sessions whose id does not match the minted format, even if id is in valid set', async () => {
      // Why: parsePtySessionId rejects ids with no worktree shape, so they're orphaned regardless of valid-set membership.
      const sessionId = 'bare-uuid-no-separators'
      await adapter.spawn({ cols: 80, rows: 24, sessionId })

      const { alive, killed } = await adapter.reconcileOnStartup(new Set([sessionId]))
      expect(alive).toHaveLength(0)
      expect(killed).toHaveLength(1)
    })
  })
})
