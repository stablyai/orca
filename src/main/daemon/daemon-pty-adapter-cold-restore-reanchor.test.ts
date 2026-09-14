/* Re-anchoring after a cold restore: aliveness probing, sticky restore cache, persistence. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import type { DaemonServer } from './daemon-server'
import { HeadlessEmulator } from './headless-emulator'
import { getHistorySessionDirName } from './history-paths'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'
import type * as DaemonHealthModule from './daemon-health'
import type * as DaemonTccAttributionModule from './daemon-tcc-attribution'
import type { TerminalSnapshot } from './types'

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
  let subprocessDataOnSubscribe: string | undefined

  beforeEach(async () => {
    subprocessDataOnSubscribe = undefined
    const harness = await startDaemonAdapterHarness((opts) => {
      lastSpawnOpts = opts
      lastSubprocess = createMockSubprocess(subprocessDataOnSubscribe)
      return lastSubprocess
    })
    dir = harness.dir
    socketPath = harness.socketPath
    tokenPath = harness.tokenPath
    server = harness.server
    adapter = harness.adapter
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

  describe('history integration', () => {
    let historyDir: string
    let historyAdapter: DaemonPtyAdapter

    beforeEach(() => {
      historyDir = join(dir, 'history')
    })

    afterEach(async () => {
      historyAdapter?.dispose()
    })

    it('re-anchors a cold-restored session with a full checkpoint on the first tick', async () => {
      const adapterClass = DaemonPtyAdapter as unknown as { CHECKPOINT_INTERVAL_MS: number }
      const previousInterval = adapterClass.CHECKPOINT_INTERVAL_MS
      adapterClass.CHECKPOINT_INTERVAL_MS = 25

      try {
        // Simulate a previous daemon crash with stale checkpoint + log files.
        const sessionId = 'cold-restore-reanchor'
        const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
        mkdirSync(sessionDir, { recursive: true })
        writeFileSync(
          join(sessionDir, 'meta.json'),
          JSON.stringify({
            cwd: '/projects/myapp',
            cols: 80,
            rows: 24,
            startedAt: '2026-04-15T10:00:00Z',
            endedAt: null,
            exitCode: null
          })
        )
        writeFileSync(join(sessionDir, 'scrollback.bin'), 'pre-crash output\r\n')

        historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
        const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
        expect(result.coldRestore).toBeDefined()

        const checkpointSpy = vi.spyOn(historyAdapter.getHistoryManager()!, 'checkpoint')
        const appendSpy = vi.spyOn(historyAdapter.getHistoryManager()!, 'appendIncrements')

        lastSubprocess._simulateData('revived session output\r\n')
        await waitFor(() => checkpointSpy.mock.calls.length === 1)

        // Why: appending fresh records to the pre-crash log would fail the sequence check on a second crash; a full checkpoint resets the log to a new generation.
        expect(appendSpy).not.toHaveBeenCalled()
        expect(checkpointSpy).toHaveBeenCalledWith(
          sessionId,
          expect.objectContaining({ snapshotAnsi: expect.stringContaining('revived session') }),
          { pendingOutputSeq: expect.any(Number) }
        )

        // Subsequent ticks return to incremental appends.
        lastSubprocess._simulateData('later output\r\n')
        await waitFor(() => appendSpy.mock.calls.length === 1)
        expect(checkpointSpy).toHaveBeenCalledTimes(1)
      } finally {
        adapterClass.CHECKPOINT_INTERVAL_MS = previousInterval
      }
    })

    it('clears a stale snapshot cooldown when the cold-restore re-anchor is flagged', async () => {
      // Simulate a previous daemon crash with recoverable history on disk.
      const sessionId = 'cold-restore-stale-cooldown'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'pre-crash output\r\n')

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const internals = historyAdapter as unknown as {
        lastFullCheckpointAt: Map<string, number>
        sessionsNeedingFullCheckpoint: Set<string>
      }
      // A daemon respawn inside one adapter keeps this map, so seed a fresh cooldown as if the pre-crash generation just snapshotted.
      internals.lastFullCheckpointAt.set(sessionId, Date.now())

      await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })

      // The revived generation has no checkpoint of its own — the re-anchor must not inherit the previous generation's cooldown.
      expect(internals.sessionsNeedingFullCheckpoint.has(sessionId)).toBe(true)
      expect(internals.lastFullCheckpointAt.has(sessionId)).toBe(false)
    })

    it('re-anchors a warm reattach the adapter was not already managing', async () => {
      const sessionId = 'warm-reattach-reanchor'
      const first = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      await first.spawn({ cols: 80, rows: 24, sessionId })
      first.dispose()

      // The old adapter may have drained records it never persisted (deferred hot-session tick), so appends must wait for a full snapshot to re-anchor the log.
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const internals = historyAdapter as unknown as {
        sessionsNeedingFullCheckpoint: Set<string>
        lastFullCheckpointAt: Map<string, number>
      }
      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.isReattach).toBe(true)
      expect(internals.sessionsNeedingFullCheckpoint.has(sessionId)).toBe(false)
      expect(internals.lastFullCheckpointAt.has(sessionId)).toBe(true)
    })

    it('skips the cold-restore replay when the daemon session is still alive', async () => {
      const sessionId = 'warm-reattach-skip-replay'
      const first = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      await first.spawn({ cols: 80, rows: 24, cwd: '/home/user', sessionId })
      // Why disconnectOnly: the app-quit path leaves meta.endedAt null, keeping the session crash-recoverable like every relaunch with a live daemon.
      await first.disconnectOnly()

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })

      expect(result.isReattach).toBe(true)
      expect(result.coldRestore).toBeUndefined()
      // The unmanaged-reattach re-anchor must survive a live remount overlay.
      const internals = historyAdapter as unknown as {
        sessionsNeedingFullCheckpoint: Set<string>
        lastFullCheckpointAt: Map<string, number>
      }
      expect(internals.sessionsNeedingFullCheckpoint.has(sessionId)).toBe(false)
      expect(internals.lastFullCheckpointAt.has(sessionId)).toBe(true)
    })

    it('re-anchors and resumes history after attach-only adoption', async () => {
      const sessionId = 'attach-only-history-adoption'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      const first = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const firstData: string[] = []
      first.onData(({ data }) => firstData.push(data))
      await first.spawn({ cols: 80, rows: 24, cwd: '/home/user', sessionId })

      lastSubprocess._simulateData('BASELINE-BEFORE-RESTART\r\n')
      await waitFor(() => firstData.includes('BASELINE-BEFORE-RESTART\r\n'))
      const firstInternals = first as unknown as {
        checkpointSessions(sessionIds: Iterable<string>): Promise<Set<string>>
      }
      await firstInternals.checkpointSessions([sessionId])
      expect(readFileSync(join(sessionDir, 'output.log')).includes('BASELINE-BEFORE-RESTART')).toBe(
        true
      )

      await first.disconnectOnly()
      expect(
        JSON.parse(readFileSync(join(sessionDir, 'checkpoint.json'), 'utf8')).snapshotAnsi
      ).toContain('BASELINE-BEFORE-RESTART')

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const attachedData: string[] = []
      historyAdapter.onData(({ data }) => attachedData.push(data))
      await historyAdapter.attach(sessionId)
      await historyAdapter.attach(sessionId)

      const manager = historyAdapter.getHistoryManager()!
      const managerInternals = manager as unknown as { writers: Map<string, unknown> }
      expect(historyAdapter.getActiveSessionIds()).toEqual([sessionId])
      expect(manager.hasWriter(sessionId)).toBe(true)
      expect([...managerInternals.writers]).toHaveLength(1)

      const attachedInternals = historyAdapter as unknown as {
        checkpointSessions(sessionIds: Iterable<string>): Promise<Set<string>>
      }
      expect(
        JSON.parse(readFileSync(join(sessionDir, 'checkpoint.json'), 'utf8')).snapshotAnsi
      ).toContain('BASELINE-BEFORE-RESTART')

      lastSubprocess._simulateData('FIRST-AFTER-RESTART\r\n')
      await waitFor(() => attachedData.includes('FIRST-AFTER-RESTART\r\n'))
      await attachedInternals.checkpointSessions([sessionId])
      expect(readFileSync(join(sessionDir, 'output.log')).includes('FIRST-AFTER-RESTART')).toBe(
        true
      )

      lastSubprocess._simulateData('SECOND-AFTER-RESTART\r\n')
      await waitFor(() => attachedData.includes('SECOND-AFTER-RESTART\r\n'))
      await attachedInternals.checkpointSessions([sessionId])
      const appendedLog = readFileSync(join(sessionDir, 'output.log'))
      expect(appendedLog.includes('FIRST-AFTER-RESTART')).toBe(true)
      expect(appendedLog.includes('SECOND-AFTER-RESTART')).toBe(true)

      await historyAdapter.shutdown(sessionId, { immediate: true })
      expect(historyAdapter.getActiveSessionIds()).toEqual([])
      expect(manager.hasWriter(sessionId)).toBe(false)
    })

    it('does not route an exact incarnation that exits during attach history overlay', async () => {
      const sessionId = 'attach-overlay-exit-race'
      const first = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const initial = await first.spawn({ cols: 80, rows: 24, sessionId })
      await first.disconnectOnly()

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const overlayTarget = historyAdapter as unknown as {
        overlayDurableRestoreSnapshot(
          id: string,
          snapshot: TerminalSnapshot
        ): Promise<TerminalSnapshot>
      }
      const originalOverlay = overlayTarget.overlayDurableRestoreSnapshot.bind(historyAdapter)
      let reportOverlayReady!: () => void
      const overlayReady = new Promise<void>((resolve) => {
        reportOverlayReady = resolve
      })
      let releaseOverlay!: () => void
      const overlayRelease = new Promise<void>((resolve) => {
        releaseOverlay = resolve
      })
      vi.spyOn(overlayTarget, 'overlayDurableRestoreSnapshot').mockImplementation(
        async (id, snapshot) => {
          const result = await originalOverlay(id, snapshot)
          reportOverlayReady()
          await overlayRelease
          return result
        }
      )
      const router = new DaemonPtyRouter({ current: historyAdapter, legacy: [] })
      const exits: { id: string; incarnationId?: string }[] = []
      router.onExit((event) => exits.push(event))

      const spawning = router.spawn({ cols: 80, rows: 24, sessionId, attachOnly: true })
      await overlayReady
      lastSubprocess._simulateExit(0)
      await waitFor(() => exits.some((event) => event.incarnationId === initial.incarnationId))
      releaseOverlay()

      const result = await spawning
      expect(result).toMatchObject({
        id: sessionId,
        incarnationId: initial.incarnationId,
        exitedBeforeSpawnReply: true,
        isReattach: true
      })
      const routerInternals = router as unknown as {
        sessionAdapters: Map<string, DaemonPtyAdapter>
      }
      expect(routerInternals.sessionAdapters.has(sessionId)).toBe(false)
      expect(historyAdapter.getActiveSessionIds()).toEqual([])
      expect(historyAdapter.getHistoryManager()!.hasWriter(sessionId)).toBe(false)
      router.disposeRouterOnly()
    })

    it('does not probe session aliveness when there is no restorable history', async () => {
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const client = (
        historyAdapter as unknown as {
          client: { request: (type: string, payload?: unknown) => Promise<unknown> }
        }
      ).client
      const requestSpy = vi.spyOn(client, 'request')

      await historyAdapter.spawn({ cols: 80, rows: 24, sessionId: 'fresh-no-history' })

      expect(requestSpy.mock.calls.map((call) => call[0])).not.toContain('getSize')
    })

    it('recovers cold restore when the probed session dies before createOrAttach', async () => {
      const sessionId = 'probe-race-cold-restore'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/projects/raced',
          cols: 100,
          rows: 30,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'raced output\r\n')

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const client = (
        historyAdapter as unknown as {
          client: { request: (type: string, payload?: unknown) => Promise<unknown> }
        }
      ).client
      const originalRequest = client.request.bind(client)
      // Why: simulates the probe→createOrAttach race (session dies mid-call, writing endedAt); fallback detect must still restore, not fall through to openSession which deletes the checkpoint.
      vi.spyOn(client, 'request').mockImplementation(async (type: string, payload?: unknown) => {
        if (type === 'getSize') {
          return { size: { cols: 100, rows: 30 } }
        }
        const response = await originalRequest(type, payload)
        if (type === 'createOrAttach') {
          writeFileSync(
            join(sessionDir, 'meta.json'),
            JSON.stringify({
              cwd: '/projects/raced',
              cols: 100,
              rows: 30,
              startedAt: '2026-04-15T10:00:00Z',
              endedAt: '2026-04-15T10:05:00Z',
              exitCode: 0
            })
          )
        }
        return response
      })

      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })

      expect(result.coldRestore).toBeDefined()
      expect(result.coldRestore!.scrollback).toContain('raced output')
      // The unseeded race winner is replaced before exposure, so the retained shell uses recovered dimensions as well as history.
      expect(lastSpawnOpts).toMatchObject({ sessionId, cols: 100, rows: 30 })
      // The recovery data must survive — openSession would have deleted it.
      expect(existsSync(join(sessionDir, 'scrollback.bin'))).toBe(true)
      const internals = historyAdapter as unknown as {
        sessionsNeedingFullCheckpoint: Set<string>
        lastFullCheckpointAt: Map<string, number>
      }
      expect(internals.sessionsNeedingFullCheckpoint.has(sessionId)).toBe(true)
      expect(internals.lastFullCheckpointAt.has(sessionId)).toBe(false)
    })

    it('falls back to the full cold-restore detect when the aliveness probe fails', async () => {
      const sessionId = 'probe-error-cold-restore'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/projects/probeless',
          cols: 132,
          rows: 43,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'probeless output\r\n')

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const client = (
        historyAdapter as unknown as {
          client: { request: (type: string, payload?: unknown) => Promise<unknown> }
        }
      ).client
      const originalRequest = client.request.bind(client)
      // Why: an old daemon rejects the unknown getSize method; the spawn must behave exactly like the unprobed path.
      vi.spyOn(client, 'request').mockImplementation((type: string, payload?: unknown) => {
        if (type === 'getSize') {
          return Promise.reject(new Error('Unknown request type'))
        }
        return originalRequest(type, payload)
      })

      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })

      expect(result.coldRestore).toBeDefined()
      expect(result.coldRestore!.scrollback).toContain('probeless output')
      expect(lastSpawnOpts).toMatchObject({
        sessionId,
        cwd: '/projects/probeless',
        cols: 132,
        rows: 43
      })
    })

    it('returns same cold restore on StrictMode double-mount (sticky cache)', async () => {
      const sessionId = 'sticky-cache-test'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'cached output')

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const internals = historyAdapter as unknown as {
        coldRestoreCache: { byteSize: number }
      }

      const first = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(first.coldRestore).toBeDefined()
      expect(internals.coldRestoreCache.byteSize).toBeGreaterThan(0)

      // Second call (StrictMode remount) should get cached data
      const second = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(second.coldRestore).toBeDefined()
      expect(second.coldRestore!.scrollback).toBe('cached output')

      // After ack, cold restore should not be returned
      historyAdapter.ackColdRestore(sessionId)
      expect(internals.coldRestoreCache.byteSize).toBe(0)
      const third = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(third.coldRestore).toBeUndefined()
    })

    it('drops sticky cold restore data on explicit shutdown', async () => {
      const sessionId = 'sticky-cache-shutdown-test'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'cached output')

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const internals = historyAdapter as unknown as {
        coldRestoreCache: Map<string, { scrollback: string; cwd: string; oscLinks?: unknown[] }>
      }

      await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(internals.coldRestoreCache.has(sessionId)).toBe(true)

      await historyAdapter.shutdown(sessionId, { immediate: true })

      expect(internals.coldRestoreCache.has(sessionId)).toBe(false)
    })

    it('drops sticky cold restore data on natural exit', async () => {
      const sessionId = 'sticky-cache-exit-test'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'cached output')

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const internals = historyAdapter as unknown as {
        coldRestoreCache: Map<string, { scrollback: string; cwd: string; oscLinks?: unknown[] }>
      }

      await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(internals.coldRestoreCache.has(sessionId)).toBe(true)

      lastSubprocess._simulateExit(0)
      await waitFor(() => !internals.coldRestoreCache.has(sessionId))
    })

    it('opens session for checkpointing after cold restore', async () => {
      const sessionId = 'post-restore-data'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'old output')

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.coldRestore).toBeDefined()

      await new Promise((r) => setTimeout(r, 50))

      // Why: checkpoint-based persistence doesn't seed scrollback.bin — new data lands via the periodic checkpoint timer, not per-chunk appendData.
      const meta = JSON.parse(
        readFileSync(join(historyDir, getHistorySessionDirName(sessionId), 'meta.json'), 'utf-8')
      )
      expect(meta.cwd).toBe('/tmp')
      expect(meta.cols).toBe(80)
      expect(meta.rows).toBe(24)
    })

    it('keeps recovered scrollback when the fresh daemon session re-anchors history', async () => {
      const sessionId = 'cold-restore-reanchor'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          startedAt: '2026-07-10T08:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'recovered marker\r\n')
      subprocessDataOnSubscribe = 'fresh shell output\r\n'
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.coldRestore?.scrollback).toContain('recovered marker')

      const internals = historyAdapter as unknown as {
        checkpointSessions(sessionIds: Iterable<string>): Promise<Set<string>>
      }
      await internals.checkpointSessions([sessionId])
      const checkpointPath = join(sessionDir, 'checkpoint.json')
      const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'))

      expect(checkpoint.snapshotAnsi).toContain('recovered marker')
      expect(checkpoint.snapshotAnsi).toContain('fresh shell output')
      expect(checkpoint.snapshotAnsi.indexOf('recovered marker')).toBeLessThan(
        checkpoint.snapshotAnsi.indexOf('fresh shell output')
      )
    })

    it('keeps recovery persistence suspended across an adapter restart after seed failure', async () => {
      const sessionId = 'cold-restore-seed-failure'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          startedAt: '2026-07-10T08:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'recovered marker\r\n')

      const first = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const originalWriteSync = HeadlessEmulator.prototype.writeSync
      const writeSyncSpy = vi
        .spyOn(HeadlessEmulator.prototype, 'writeSync')
        .mockImplementation(function (this: HeadlessEmulator, data) {
          return data.includes('recovered marker') ? false : originalWriteSync.call(this, data)
        })
      try {
        await first.spawn({ cols: 80, rows: 24, sessionId })
        lastSubprocess._simulateData('fresh-only output\r\n')
        await first.disconnectOnly()

        historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
        const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
        expect(result.coldRestore?.scrollback).toContain('recovered marker')
        const internals = historyAdapter as unknown as {
          checkpointSessions(sessionIds: Iterable<string>): Promise<Set<string>>
        }
        await internals.checkpointSessions([sessionId])

        expect(existsSync(join(sessionDir, 'checkpoint.json'))).toBe(false)
        expect(readFileSync(join(sessionDir, 'scrollback.bin'), 'utf8')).toContain(
          'recovered marker'
        )
      } finally {
        writeSyncSpy.mockRestore()
      }
    })

    it('does not cold-restore for clean shutdown (endedAt set)', async () => {
      const sessionId = 'clean-exit'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: '2026-04-15T12:00:00Z',
          exitCode: 0
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'old data')

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.coldRestore).toBeUndefined()
    })

    it('stores history under an encoded directory key for Windows-safe session ids', async () => {
      const sessionId = 'repo1::/path/wt1@@abcd'
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const { id } = await historyAdapter.spawn({
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        sessionId
      })

      expect(id).toBe(sessionId)
      expect(existsSync(join(historyDir, getHistorySessionDirName(sessionId), 'meta.json'))).toBe(
        true
      )
    })
  })
})
