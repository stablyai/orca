/* Periodic/final history checkpointing: scheduling, work caps, cooldown and shutdown writes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonServer } from './daemon-server'
import { getHistorySessionDirName } from './history-paths'
import type { PendingOutputRecord } from './types'
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

const itOnPosix = process.platform === 'win32' ? it.skip : it

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

    it('does not write to disk on individual data events (checkpoint-based)', async () => {
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const { id } = await historyAdapter.spawn({
        cols: 80,
        rows: 24,
        cwd: '/home/user',
        sessionId: 'hist-test'
      })

      lastSubprocess._simulateData('hello from pty\r\n')
      await new Promise((r) => setTimeout(r, 50))

      // Why: checkpoint-based persistence writes checkpoint.json on a timer, never scrollback.bin per data event.
      expect(existsSync(join(historyDir, getHistorySessionDirName(id), 'scrollback.bin'))).toBe(
        false
      )
    })

    it('appends increments for only dirty sessions on the periodic timer', async () => {
      const adapterClass = DaemonPtyAdapter as unknown as { CHECKPOINT_INTERVAL_MS: number }
      const previousInterval = adapterClass.CHECKPOINT_INTERVAL_MS
      adapterClass.CHECKPOINT_INTERVAL_MS = 25

      try {
        historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
        const { id } = await historyAdapter.spawn({
          cols: 80,
          rows: 24,
          cwd: '/home/user',
          sessionId: 'dirty-checkpoint'
        })
        const checkpointSpy = vi.spyOn(historyAdapter.getHistoryManager()!, 'checkpoint')
        const appendSpy = vi.spyOn(historyAdapter.getHistoryManager()!, 'appendIncrements')

        await new Promise((r) => setTimeout(r, 80))

        // Why: idle terminals can be numerous; a periodic pass with no data must not serialize every live session.
        expect(appendSpy).not.toHaveBeenCalled()

        lastSubprocess._simulateData('new output\r\n')
        await waitFor(() => appendSpy.mock.calls.length === 1)
        expect(appendSpy).toHaveBeenCalledWith(id, expect.any(Number), [
          { kind: 'output', data: 'new output\r\n' }
        ])
        // Why: the periodic tick must persist increments, never re-serialize the full emulator buffer (the issue #5096 stall).
        expect(checkpointSpy).not.toHaveBeenCalled()
        const logPath = join(historyDir, getHistorySessionDirName(id), 'output.log')
        await waitFor(() => {
          try {
            return readFileSync(logPath).includes('new output')
          } catch {
            return false
          }
        })

        await new Promise((r) => setTimeout(r, 80))
        expect(appendSpy).toHaveBeenCalledTimes(1)
      } finally {
        adapterClass.CHECKPOINT_INTERVAL_MS = previousInterval
      }
    })

    it('limits concurrent checkpoint snapshot and disk work', async () => {
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const releaseSnapshotRequests: (() => void)[] = []
      const requestedSessionIds: string[] = []
      let inFlight = 0
      let maxInFlight = 0
      const request = vi.fn(async (_type: string, payload: { sessionId: string }) => {
        requestedSessionIds.push(payload.sessionId)
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise<void>((resolve) => {
          releaseSnapshotRequests.push(() => {
            inFlight--
            resolve()
          })
        })
        return {
          records: [{ kind: 'output', data: payload.sessionId }],
          seq: 1,
          overflowed: false,
          snapshot: null
        }
      })
      const checkpoint = vi.fn(async () => 'committed' as const)
      const appendIncrements = vi.fn(async () => 'ok' as const)
      const dispose = vi.fn(async () => {})
      const disconnect = vi.fn()
      const internals = historyAdapter as unknown as {
        client: { request: typeof request; disconnect: typeof disconnect }
        historyManager: {
          checkpoint: typeof checkpoint
          appendIncrements: typeof appendIncrements
          dispose: typeof dispose
        }
        checkpointSessions(sessionIds: Iterable<string>): Promise<Set<string>>
      }
      internals.client = { request, disconnect }
      internals.historyManager = { checkpoint, appendIncrements, dispose }

      const checkpointing = internals.checkpointSessions(['a', 'b', 'c', 'd', 'e', 'f'])
      await waitFor(() => requestedSessionIds.length === 4)

      expect(maxInFlight).toBe(4)
      expect(requestedSessionIds).toEqual(['a', 'b', 'c', 'd'])

      for (const release of releaseSnapshotRequests.splice(0)) {
        release()
      }
      await waitFor(() => requestedSessionIds.length === 6)

      expect(maxInFlight).toBe(4)

      for (const release of releaseSnapshotRequests.splice(0)) {
        release()
      }
      await expect(checkpointing).resolves.toEqual(new Set(['a', 'b', 'c', 'd', 'e', 'f']))
      expect(appendIncrements).toHaveBeenCalledTimes(6)
      expect(checkpoint).not.toHaveBeenCalled()
    })

    it('keeps abandoned periodic checkpoints within the global work cap', async () => {
      const adapterClass = DaemonPtyAdapter as unknown as {
        PERIODIC_CHECKPOINT_DEADLINE_MS: number
      }
      const previousDeadline = adapterClass.PERIODIC_CHECKPOINT_DEADLINE_MS
      adapterClass.PERIODIC_CHECKPOINT_DEADLINE_MS = 5
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const releases: (() => void)[] = []
      const requestedSessionIds: string[] = []
      const request = vi.fn(async (_type: string, payload: { sessionId: string }) => {
        requestedSessionIds.push(payload.sessionId)
        await new Promise<void>((resolve) => releases.push(resolve))
        return {
          records: [{ kind: 'output', data: payload.sessionId }],
          seq: 1,
          overflowed: false,
          snapshot: null
        }
      })
      const appendIncrements = vi.fn(async () => 'ok' as const)
      const internals = historyAdapter as unknown as {
        client: { request: typeof request; disconnect: ReturnType<typeof vi.fn> }
        historyManager: {
          checkpoint: ReturnType<typeof vi.fn>
          appendIncrements: typeof appendIncrements
          dispose: ReturnType<typeof vi.fn>
        }
        checkpointSessions(sessionIds: Iterable<string>): Promise<Set<string>>
        nonFinalCheckpointAdmissionSessionIds: Set<string>
        tryAdmitNonFinalCheckpoint(sessionId: string): boolean
      }
      internals.client = { request, disconnect: vi.fn() }
      internals.historyManager = {
        checkpoint: vi.fn(async () => 'committed' as const),
        appendIncrements,
        dispose: vi.fn(async () => {})
      }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const tryAdmit = vi.spyOn(internals, 'tryAdmitNonFinalCheckpoint')

      try {
        const checkpointing = internals.checkpointSessions(['a', 'b', 'c', 'd', 'e', 'f'])
        await waitFor(() => requestedSessionIds.length === 4)
        await expect(checkpointing).resolves.toEqual(new Set())

        expect(requestedSessionIds).toEqual(['a', 'b', 'c', 'd'])
        expect(tryAdmit).toHaveBeenCalledTimes(4)
        expect(internals.nonFinalCheckpointAdmissionSessionIds).toEqual(
          new Set(['a', 'b', 'c', 'd'])
        )
        expect(warn).toHaveBeenCalledWith('[history] periodic checkpoint deadline exceeded:', 'a')

        for (const release of releases) {
          release()
        }
        await waitFor(() => internals.nonFinalCheckpointAdmissionSessionIds.size === 0)
      } finally {
        adapterClass.PERIODIC_CHECKPOINT_DEADLINE_MS = previousDeadline
        warn.mockRestore()
      }
    })

    it('lets one session hold only one global non-final admission', () => {
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const internals = historyAdapter as unknown as {
        tryAdmitNonFinalCheckpoint(sessionId: string): boolean
        releaseNonFinalCheckpointAdmission(sessionId: string): void
        nonFinalCheckpointAdmissionSessionIds: Set<string>
        nonFinalAdmissionDeniedSessionIds: Set<string>
      }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      try {
        expect(internals.tryAdmitNonFinalCheckpoint('stalled')).toBe(true)
        expect(internals.tryAdmitNonFinalCheckpoint('stalled')).toBe(false)
        expect(warn).toHaveBeenCalledWith(
          '[history] non-final checkpoint already in flight:',
          'stalled'
        )
        expect(internals.tryAdmitNonFinalCheckpoint('healthy-a')).toBe(true)
        expect(internals.tryAdmitNonFinalCheckpoint('healthy-b')).toBe(true)
        expect(internals.tryAdmitNonFinalCheckpoint('healthy-c')).toBe(true)
        expect(internals.tryAdmitNonFinalCheckpoint('overflow')).toBe(false)
        expect(internals.tryAdmitNonFinalCheckpoint('another-overflow')).toBe(false)

        expect(internals.nonFinalCheckpointAdmissionSessionIds).toEqual(
          new Set(['stalled', 'healthy-a', 'healthy-b', 'healthy-c'])
        )
        expect(internals.nonFinalAdmissionDeniedSessionIds).toEqual(new Set(['stalled']))
        expect(warn).toHaveBeenCalledWith(
          '[history] non-final checkpoint global admission limit reached:',
          'overflow'
        )
        expect(
          warn.mock.calls.filter(
            ([message]) =>
              message === '[history] non-final checkpoint global admission limit reached:'
          )
        ).toHaveLength(1)

        internals.releaseNonFinalCheckpointAdmission('stalled')
        expect(internals.nonFinalAdmissionDeniedSessionIds).toEqual(new Set())
        expect(internals.tryAdmitNonFinalCheckpoint('overflow')).toBe(true)
      } finally {
        warn.mockRestore()
      }
    })

    it('logs non-final checkpoint RPC failures', async () => {
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const request = vi.fn(async () => {
        throw new Error('daemon socket unavailable')
      })
      const internals = historyAdapter as unknown as {
        client: { request: typeof request; disconnect: ReturnType<typeof vi.fn> }
        checkpointSessions(sessionIds: Iterable<string>): Promise<Set<string>>
      }
      internals.client = { request, disconnect: vi.fn() }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      try {
        await expect(internals.checkpointSessions(['broken'])).resolves.toEqual(new Set())
        expect(warn).toHaveBeenCalledWith(
          '[history] checkpoint failed:',
          'broken',
          expect.objectContaining({ message: 'daemon socket unavailable' })
        )
      } finally {
        warn.mockRestore()
      }
    })

    it('logs a periodic checkpoint failure that arrives after its deadline', async () => {
      const adapterClass = DaemonPtyAdapter as unknown as {
        PERIODIC_CHECKPOINT_DEADLINE_MS: number
      }
      const previousDeadline = adapterClass.PERIODIC_CHECKPOINT_DEADLINE_MS
      adapterClass.PERIODIC_CHECKPOINT_DEADLINE_MS = 5
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      let rejectRequest!: (error: unknown) => void
      const request = vi.fn(
        async () =>
          await new Promise<never>((_resolve, reject) => {
            rejectRequest = reject
          })
      )
      const internals = historyAdapter as unknown as {
        client: { request: typeof request; disconnect: ReturnType<typeof vi.fn> }
        checkpointSessions(sessionIds: Iterable<string>): Promise<Set<string>>
      }
      internals.client = { request, disconnect: vi.fn() }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      try {
        const checkpointing = internals.checkpointSessions(['late-failure'])
        await waitFor(() => request.mock.calls.length === 1)
        await expect(checkpointing).resolves.toEqual(new Set())

        rejectRequest(new Error('late daemon failure'))
        await waitFor(() =>
          warn.mock.calls.some(
            ([message, sessionId, error]) =>
              message === '[history] checkpoint failed:' &&
              sessionId === 'late-failure' &&
              error instanceof Error &&
              error.message === 'late daemon failure'
          )
        )
      } finally {
        adapterClass.PERIODIC_CHECKPOINT_DEADLINE_MS = previousDeadline
        warn.mockRestore()
      }
    })

    describe('full-snapshot cooldown', () => {
      type CooldownInternals = {
        client: { request: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }
        historyManager: {
          checkpoint: ReturnType<typeof vi.fn>
          appendIncrements: ReturnType<typeof vi.fn>
          dispose: ReturnType<typeof vi.fn>
        }
        checkpointSessions(
          sessionIds: Iterable<string>,
          opts?: { final?: boolean; teardown?: boolean }
        ): Promise<Set<string>>
        sessionsNeedingFullCheckpoint: Set<string>
        lastFullCheckpointAt: Map<string, number>
      }

      function makeCooldownHarness(takeResult: {
        overflowed: boolean
        appendResult?: 'ok' | 'needs-checkpoint'
        checkpointResult?: 'committed' | 'retryable' | 'unavailable'
        snapshotRecords?: PendingOutputRecord[]
      }): CooldownInternals {
        historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
        const request = vi.fn(async (_type: string, payload: Record<string, unknown>) => {
          if (payload.includeSnapshot === true) {
            return {
              records: takeResult.snapshotRecords ?? [],
              seq: 2,
              overflowed: false,
              snapshot: { cols: 80, rows: 24 }
            }
          }
          return {
            records: [{ kind: 'output', data: 'x' }],
            seq: 1,
            overflowed: takeResult.overflowed,
            snapshot: null
          }
        })
        const internals = historyAdapter as unknown as CooldownInternals
        internals.client = { request, disconnect: vi.fn() }
        internals.historyManager = {
          checkpoint: vi.fn(async () => takeResult.checkpointResult ?? 'committed'),
          appendIncrements: vi.fn(async () => takeResult.appendResult ?? 'ok'),
          dispose: vi.fn(async () => {})
        }
        return internals
      }

      it('bounds overflow-triggered full snapshots to one per cooldown window', async () => {
        const internals = makeCooldownHarness({ overflowed: true })

        // First overflow: full snapshot allowed immediately.
        await expect(internals.checkpointSessions(['hot'])).resolves.toEqual(new Set(['hot']))
        expect(internals.historyManager.checkpoint).toHaveBeenCalledTimes(1)

        // Second tick inside the cooldown: the overflow defers and flags the session; no snapshot write.
        await expect(internals.checkpointSessions(['hot'])).resolves.toEqual(new Set())
        expect(internals.historyManager.checkpoint).toHaveBeenCalledTimes(1)
        expect(internals.sessionsNeedingFullCheckpoint.has('hot')).toBe(true)
        const requestsAfterSecondTick = internals.client.request.mock.calls.length

        // Ticks 3..24 (a hot session over ~2 minutes): flagged + cooling down short-circuits with zero daemon RPCs and zero disk writes.
        for (let i = 0; i < 22; i++) {
          await expect(internals.checkpointSessions(['hot'])).resolves.toEqual(new Set())
        }
        expect(internals.historyManager.checkpoint).toHaveBeenCalledTimes(1)
        expect(internals.client.request.mock.calls.length).toBe(requestsAfterSecondTick)

        // Cooldown expiry: the deferred full snapshot lands and clears the flag.
        internals.lastFullCheckpointAt.set('hot', Date.now() - 46_000)
        await expect(internals.checkpointSessions(['hot'])).resolves.toEqual(new Set(['hot']))
        expect(internals.historyManager.checkpoint).toHaveBeenCalledTimes(2)
        expect(internals.sessionsNeedingFullCheckpoint.has('hot')).toBe(false)
      })

      it('lets final checkpoints bypass the cooldown', async () => {
        const internals = makeCooldownHarness({ overflowed: true })
        await internals.checkpointSessions(['hot'])
        expect(internals.historyManager.checkpoint).toHaveBeenCalledTimes(1)

        // Cooldown is active, but quit/sleep persistence must not defer — stale-on-crash is acceptable, stale-on-clean-exit is not.
        await expect(internals.checkpointSessions(['hot'], { final: true })).resolves.toEqual(
          new Set(['hot'])
        )
        expect(internals.historyManager.checkpoint).toHaveBeenCalledTimes(2)
      })

      it('defers log-cap (needs-checkpoint) snapshots inside the cooldown', async () => {
        const internals = makeCooldownHarness({
          overflowed: false,
          appendResult: 'needs-checkpoint'
        })
        internals.lastFullCheckpointAt.set('capped', Date.now())

        await expect(internals.checkpointSessions(['capped'])).resolves.toEqual(new Set())
        expect(internals.historyManager.checkpoint).not.toHaveBeenCalled()
        expect(internals.sessionsNeedingFullCheckpoint.has('capped')).toBe(true)

        internals.lastFullCheckpointAt.set('capped', Date.now() - 46_000)
        await expect(internals.checkpointSessions(['capped'])).resolves.toEqual(new Set(['capped']))
        expect(internals.historyManager.checkpoint).toHaveBeenCalledTimes(1)
        expect(internals.sessionsNeedingFullCheckpoint.has('capped')).toBe(false)
      })

      it('defers a teardown checkpoint that fails to serialize and drops its held tail', async () => {
        const internals = makeCooldownHarness({
          overflowed: false,
          checkpointResult: 'retryable',
          // Held shell-ready bytes ride out with the teardown snapshot (Session.prepareForFinalSnapshot).
          snapshotRecords: [{ kind: 'output', data: 'held tail' }]
        })

        await expect(
          internals.checkpointSessions(['sleeping'], { final: true, teardown: true })
        ).resolves.toEqual(new Set())

        expect(internals.historyManager.checkpoint).toHaveBeenCalledTimes(1)
        expect(internals.sessionsNeedingFullCheckpoint.has('sleeping')).toBe(true)
        // Why the tail must not be appended: the output this take drained went into the failed snapshot, so the tail
        // would land at a contiguous seq over that hole and pass the log's gap detection.
        expect(internals.historyManager.appendIncrements).not.toHaveBeenCalled()
        expect(internals.lastFullCheckpointAt.has('sleeping')).toBe(false)
      })
    })

    it('does not schedule a checkpoint timer until a session is dirty', async () => {
      const adapterClass = DaemonPtyAdapter as unknown as { CHECKPOINT_INTERVAL_MS: number }
      const previousInterval = adapterClass.CHECKPOINT_INTERVAL_MS
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      adapterClass.CHECKPOINT_INTERVAL_MS = 10_000

      try {
        historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
        await historyAdapter.spawn({
          cols: 80,
          rows: 24,
          cwd: '/home/user',
          sessionId: 'idle-checkpoint'
        })

        expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 10_000)).toBe(false)

        lastSubprocess._simulateData('dirty after idle\r\n')
        await waitFor(() => setTimeoutSpy.mock.calls.some(([, delay]) => delay === 10_000))
      } finally {
        adapterClass.CHECKPOINT_INTERVAL_MS = previousInterval
        setTimeoutSpy.mockRestore()
      }
    })

    it('clears a pending checkpoint timer when the last dirty session closes', async () => {
      const adapterClass = DaemonPtyAdapter as unknown as { CHECKPOINT_INTERVAL_MS: number }
      const previousInterval = adapterClass.CHECKPOINT_INTERVAL_MS
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
      adapterClass.CHECKPOINT_INTERVAL_MS = 10_000

      try {
        historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
        const { id } = await historyAdapter.spawn({
          cols: 80,
          rows: 24,
          cwd: '/home/user',
          sessionId: 'close-dirty-checkpoint'
        })
        const internals = historyAdapter as unknown as {
          dirtySessionVersions: Map<string, number>
        }

        lastSubprocess._simulateData('dirty before close\r\n')
        await waitFor(() => internals.dirtySessionVersions.has(id))
        const callsBeforeClose = clearTimeoutSpy.mock.calls.length

        await historyAdapter.shutdown(id, { immediate: true })

        expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(callsBeforeClose)
      } finally {
        adapterClass.CHECKPOINT_INTERVAL_MS = previousInterval
        clearTimeoutSpy.mockRestore()
      }
    })

    it('checkpoints before keep-history shutdown so sleep can cold restore latest output', async () => {
      const adapterClass = DaemonPtyAdapter as unknown as { CHECKPOINT_INTERVAL_MS: number }
      const previousInterval = adapterClass.CHECKPOINT_INTERVAL_MS
      adapterClass.CHECKPOINT_INTERVAL_MS = 10_000

      try {
        historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
        const { id } = await historyAdapter.spawn({
          cols: 80,
          rows: 24,
          cwd: '/home/user',
          sessionId: 'sleep-checkpoint'
        })
        const checkpointSpy = vi.spyOn(historyAdapter.getHistoryManager()!, 'checkpoint')

        lastSubprocess._simulateData('latest before sleep\r\n')
        await historyAdapter.shutdown(id, { immediate: true, keepHistory: true })

        expect(checkpointSpy).toHaveBeenCalledWith(
          id,
          expect.objectContaining({ snapshotAnsi: expect.stringContaining('latest before sleep') }),
          { pendingOutputSeq: expect.any(Number) }
        )
        expect(existsSync(join(historyDir, getHistorySessionDirName(id)))).toBe(true)

        const restored = await historyAdapter.spawn({
          cols: 80,
          rows: 24,
          cwd: '/home/user',
          sessionId: id
        })
        expect(restored.coldRestore?.scrollback).toContain('latest before sleep')
        historyAdapter.ackColdRestore(id)

        const remountAfterAck = await historyAdapter.spawn({
          cols: 80,
          rows: 24,
          cwd: '/home/user',
          sessionId: id
        })
        expect(remountAfterAck.coldRestore).toBeUndefined()
      } finally {
        adapterClass.CHECKPOINT_INTERVAL_MS = previousInterval
      }
    })

    it('cold restores the second sleep/wake cycle with post-wake output', async () => {
      const adapterClass = DaemonPtyAdapter as unknown as { CHECKPOINT_INTERVAL_MS: number }
      const previousInterval = adapterClass.CHECKPOINT_INTERVAL_MS
      adapterClass.CHECKPOINT_INTERVAL_MS = 10_000

      try {
        historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
        const { id } = await historyAdapter.spawn({
          cols: 80,
          rows: 24,
          cwd: '/home/user',
          sessionId: 'sleep-wake-cycles'
        })

        lastSubprocess._simulateData('first cycle content\r\n')
        await historyAdapter.shutdown(id, { immediate: true, keepHistory: true })
        const metaPath = join(historyDir, getHistorySessionDirName(id), 'meta.json')
        const checkpointPath = join(historyDir, getHistorySessionDirName(id), 'checkpoint.json')
        // Why: keep-history sleep stays unclean so cold restore stays eligible; the final checkpoint is the deterministic handoff signal.
        expect(JSON.parse(readFileSync(metaPath, 'utf-8')).endedAt).toBeNull()
        expect(JSON.parse(readFileSync(checkpointPath, 'utf-8')).snapshotAnsi).toContain(
          'first cycle content'
        )

        const firstWake = await historyAdapter.spawn({
          cols: 80,
          rows: 24,
          cwd: '/home/user',
          sessionId: id
        })
        expect(firstWake.coldRestore?.scrollback).toContain('first cycle content')
        historyAdapter.ackColdRestore(id)
        expect(historyAdapter.hasPty(id)).toBe(true)

        lastSubprocess._simulateData('second cycle content\r\n')
        await historyAdapter.shutdown(id, { immediate: true, keepHistory: true })
        expect(JSON.parse(readFileSync(metaPath, 'utf-8')).endedAt).toBeNull()
        expect(JSON.parse(readFileSync(checkpointPath, 'utf-8')).snapshotAnsi).toContain(
          'second cycle content'
        )

        const secondWake = await historyAdapter.spawn({
          cols: 80,
          rows: 24,
          cwd: '/home/user',
          sessionId: id
        })
        expect(secondWake.coldRestore?.scrollback).toContain('second cycle content')
      } finally {
        adapterClass.CHECKPOINT_INTERVAL_MS = previousInterval
      }
    })

    it('writes meta.json with endedAt on exit', async () => {
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const { id } = await historyAdapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'exit-hist'
      })

      lastSubprocess._simulateExit(0)
      await new Promise((r) => setTimeout(r, 50))

      const meta = JSON.parse(
        readFileSync(join(historyDir, getHistorySessionDirName(id), 'meta.json'), 'utf-8')
      )
      expect(meta.endedAt).toBeDefined()
      expect(meta.exitCode).toBe(0)
    })

    it('removes history on explicit shutdown', async () => {
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const { id } = await historyAdapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'shutdown-hist'
      })

      lastSubprocess._simulateData('data')
      await new Promise((r) => setTimeout(r, 50))

      expect(existsSync(join(historyDir, getHistorySessionDirName(id)))).toBe(true)

      await historyAdapter.shutdown(id, { immediate: true })
      await new Promise((r) => setTimeout(r, 50))

      expect(existsSync(join(historyDir, getHistorySessionDirName(id)))).toBe(false)
    })

    it('writes a final checkpoint before keepHistory shutdown', async () => {
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const { id } = await historyAdapter.spawn({
        cols: 80,
        rows: 24,
        cwd: '/home/user',
        sessionId: 'sleep-checkpoint'
      })
      const checkpointSpy = vi.spyOn(historyAdapter.getHistoryManager()!, 'checkpoint')

      lastSubprocess._simulateData('fresh output before sleep\r\n')
      await historyAdapter.shutdown(id, { immediate: true, keepHistory: true })

      expect(checkpointSpy).toHaveBeenCalledWith(
        id,
        expect.objectContaining({ snapshotAnsi: expect.stringContaining('fresh output') }),
        { pendingOutputSeq: expect.any(Number) }
      )
      expect(existsSync(join(historyDir, getHistorySessionDirName(id)))).toBe(true)
    })

    itOnPosix('persists final take records that are not represented in the snapshot', async () => {
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const { id } = await historyAdapter.spawn({
        cols: 80,
        rows: 24,
        cwd: '/home/user',
        command: 'printf ready',
        env: { SHELL: '/bin/zsh' },
        sessionId: 'sleep-checkpoint-tail'
      })
      const checkpointSpy = vi.spyOn(historyAdapter.getHistoryManager()!, 'checkpoint')

      lastSubprocess._simulateData('\x1b]777;orca-shell-ready')
      await historyAdapter.shutdown(id, { immediate: true, keepHistory: true })

      expect(checkpointSpy).toHaveBeenCalledWith(
        id,
        expect.objectContaining({
          pendingEscapeTailAnsi: expect.stringContaining('\x1b]777;orca-shell-ready')
        }),
        { pendingOutputSeq: expect.any(Number) }
      )
    })

    it('returns cold restore data when disk history has unclean shutdown', async () => {
      // Simulate a previous daemon crash: write history files without endedAt
      const sessionId = 'cold-restore-test'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/projects/myapp',
          cols: 120,
          rows: 40,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), '$ npm run dev\r\nServer running...\r\n')

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.id).toBe(sessionId)
      expect(result.coldRestore).toBeDefined()
      expect(result.coldRestore!.scrollback).toContain('Server running')
      expect(result.coldRestore!.cwd).toBe('/projects/myapp')
      expect(result.coldRestore).toMatchObject({ cols: 120, rows: 40 })
      expect(lastSpawnOpts).toMatchObject({
        sessionId,
        cwd: '/projects/myapp',
        cols: 120,
        rows: 40
      })
    })
  })
})
