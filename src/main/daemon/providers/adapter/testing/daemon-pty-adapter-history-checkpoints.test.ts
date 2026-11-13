import '../../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DaemonPtyAdapter } from '../daemon-pty-adapter'
import type { DaemonServer } from '../../../server/daemon-server'
import { getHistorySessionDirName } from '../../../history/storage/history-paths'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'
import type * as DaemonHealthModule from '../../../health/daemon-health'
import type * as DaemonTccAttributionModule from '../../../permissions/daemon-tcc-attribution'
import * as startupCwdProbe from '../../../../ipc/pty/host-env/startup-cwd-directory-exists'

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

vi.mock('../../../health/daemon-health', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonHealthModule>()
  return {
    ...actual,
    getMacDaemonSystemResolverHealth: getMacDaemonSystemResolverHealthMock
  }
})

vi.mock('../../../permissions/daemon-tcc-attribution', async (importOriginal) => {
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

        expect(appendSpy).not.toHaveBeenCalled()

        lastSubprocess._simulateData('new output\r\n')
        await waitFor(() => appendSpy.mock.calls.length === 1)
        expect(appendSpy).toHaveBeenCalledWith(id, expect.any(Number), [
          { kind: 'output', data: 'new output\r\n' }
        ])
        // Full emulator serialization on each dirty tick caused main-process stalls (#5096).
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
        // Keep sleep history unclean so wake remains eligible for cold restore.
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

    // Preserve an unverified recovered cwd; fall back only when the directory is proven missing.
    it.each([
      { deleted: false, source: 'recovered-history', inconclusive: false },
      { deleted: false, source: 'recovered-history', inconclusive: true },
      { deleted: true, source: 'request', inconclusive: false }
    ])('returns cold restore data after an unclean shutdown (deleted: $deleted)', async (c) => {
      const sessionId = 'cold-restore-test'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      const startedCwd = c.deleted ? historyDir : dir
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: c.deleted ? join(dir, 'deleted') : dir,
          cols: 120,
          rows: 40,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), '$ npm run dev\r\nServer running...\r\n')

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const probe = c.inconclusive
        ? vi.spyOn(startupCwdProbe, 'probeRecoveredStartupCwdDirectory').mockResolvedValue(null)
        : undefined
      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId, cwd: historyDir })
      probe?.mockRestore()
      expect(result.id).toBe(sessionId)
      expect(result.coldRestore).toBeDefined()
      expect(result.coldRestore!.scrollback).toContain('Server running')
      expect(result.coldRestore!.cwd).toBe(startedCwd)
      expect(result.startupCwdSource).toBe(c.source)
      expect(result.coldRestore).toMatchObject({ cols: 120, rows: 40 })
      expect(lastSpawnOpts).toMatchObject({
        sessionId,
        cwd: startedCwd,
        cols: 120,
        rows: 40
      })
    })
  })
})
