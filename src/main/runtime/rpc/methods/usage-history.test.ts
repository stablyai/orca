import '../unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { USAGE_HISTORY_METHODS } from './usage-history'
import { startOrcadUsageHistory } from '../../../orcad/orcad-usage-history'
import type { OrcadRuntimeCleanup } from '../../../orcad/orcad-runtime-lifetime'
import { codexUsageAggregation } from '../../../codex-usage/codex-usage-aggregation'
import { CodexUsageStore } from '../../../codex-usage/store'
import type { CodexUsageAttributedEvent } from '../../../codex-usage/types'
import type { UsageHistoryProvider } from '../../../../shared/usage-history-types'
import {
  scanClaudeUsageFilesViaWorker,
  scanCodexUsageFilesViaWorker,
  scanMuseUsageFilesViaWorker,
  scanOpenCodeUsageDatabasesViaWorker
} from '../../../usage/usage-scan-worker-spawn'

vi.mock('../../../usage/usage-scan-worker-spawn', () => ({
  scanClaudeUsageFilesViaWorker: vi.fn(),
  scanCodexUsageFilesViaWorker: vi.fn(),
  scanMuseUsageFilesViaWorker: vi.fn(),
  scanOpenCodeUsageDatabasesViaWorker: vi.fn(),
  splitUsageCacheFileViaWorker: vi.fn()
}))
vi.mock('../../../telemetry/client', () => ({ isTelemetryEnabled: () => false }))

const PROVIDERS: readonly UsageHistoryProvider[] = ['claude', 'codex', 'opencode', 'muse']
let directory: string
let cleanups: OrcadRuntimeCleanup[]

function event(day: string): CodexUsageAttributedEvent {
  return {
    sessionId: 'multi-day-session',
    timestamp: `${day}T10:00:00Z`,
    eventKey: day,
    day,
    model: 'gpt-5.4',
    cwd: '/fixture/folder',
    projectKey: 'folder',
    projectLabel: 'Folder',
    repoId: 'folder-repo',
    worktreeId: 'folder',
    inputTokens: 1000,
    cachedInputTokens: 900,
    outputTokens: 200,
    reasoningOutputTokens: 150,
    totalTokens: 1200,
    hasInferredPricing: false,
    longContextInputTokens: 0,
    longContextCachedInputTokens: 0,
    longContextOutputTokens: 0
  }
}

function boot() {
  const runtime = new OrcaRuntimeService()
  startOrcadUsageHistory(
    directory,
    { getRepos: () => [], getAllWorktreeMeta: () => ({}) },
    runtime.usageHistory,
    (cleanup) => cleanups.push(cleanup)
  )
  const dispatcher = new RpcDispatcher({ runtime, methods: USAGE_HISTORY_METHODS })
  return {
    history: runtime.usageHistory,
    call: (method: string, params: unknown) =>
      dispatcher.dispatch({ id: method, authToken: 'fixture', method, params })
  }
}

async function stop(): Promise<void> {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup({ failed: false })
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-usage-history-rpc-'))
  cleanups = []
  vi.mocked(scanClaudeUsageFilesViaWorker)
    .mockReset()
    .mockResolvedValue({ sessions: [], dailyAggregates: [] })
  vi.mocked(scanCodexUsageFilesViaWorker)
    .mockReset()
    .mockResolvedValue(codexUsageAggregation.aggregate([event('2026-10-23'), event('2026-10-24')]))
  vi.mocked(scanMuseUsageFilesViaWorker)
    .mockReset()
    .mockResolvedValue({ sessions: [], dailyAggregates: [] })
  vi.mocked(scanOpenCodeUsageDatabasesViaWorker)
    .mockReset()
    .mockResolvedValue({ sessions: [], dailyAggregates: [] })
})

afterEach(async () => {
  await stop()
  rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('owner historical usage RPC', () => {
  it('roundtrips optional account provenance through host RPC and disk, keeping legacy history explicitly unknown', async () => {
    vi.mocked(scanCodexUsageFilesViaWorker).mockResolvedValue(
      codexUsageAggregation.aggregate([
        { ...event('2026-10-23'), accountId: 'work' },
        { ...event('2026-10-24'), accountId: 'personal' },
        event('2026-10-24')
      ])
    )
    const host = boot()
    await host.call('usage.setEnabled', { provider: 'codex', enabled: true })
    await host.call('usage.refresh', { provider: 'codex', force: true })
    const query = { provider: 'codex', scope: 'all', range: 'all', includeHistory: true }
    const snapshot = await host.call('usage.getSnapshot', query)
    expect(snapshot).toMatchObject({
      ok: true,
      result: {
        summary: { totalTokens: 3600 },
        history: expect.arrayContaining([
          expect.objectContaining({ accountId: 'work', totalTokens: 1200 }),
          expect.objectContaining({ accountId: 'personal', totalTokens: 1200 }),
          expect.objectContaining({ accountId: null, totalTokens: 1200 })
        ])
      }
    })
    await stop()
    const restarted = boot()
    const restored = await restarted.call('usage.getSnapshot', query)
    expect(restored.ok && restored.result).toEqual(snapshot.ok && snapshot.result)
    const olderClient = await restarted.call('usage.getSnapshot', {
      provider: 'codex',
      scope: 'all',
      range: 'all'
    })
    expect(olderClient.ok && olderClient.result).not.toHaveProperty('history')
  })
  it('awaits persisted-state hydration before serving a snapshot', async () => {
    const host = boot()
    const hydration = Promise.withResolvers<void>()
    vi.spyOn(CodexUsageStore.prototype, 'whenLoaded').mockReturnValue(hydration.promise)
    const read = vi.spyOn(CodexUsageStore.prototype, 'getSnapshot')
    const settled = vi.fn()
    const request = host
      .call('usage.getSnapshot', {
        provider: 'codex',
        scope: 'all',
        range: 'all',
        includeHistory: true
      })
      .then(settled)
    await new Promise((resolve) => setImmediate(resolve))
    expect(read).not.toHaveBeenCalled()
    expect(settled).not.toHaveBeenCalled()
    hydration.resolve()
    await request
    expect(read).toHaveBeenCalledWith('all', 'all', undefined, true)
  })

  it('finishes an active scan before shutdown releases the persisted host history', async () => {
    const host = boot()
    await host.call('usage.setEnabled', { provider: 'codex', enabled: true })
    const scan = Promise.withResolvers<ReturnType<typeof codexUsageAggregation.aggregate>>()
    vi.mocked(scanCodexUsageFilesViaWorker).mockReturnValue(scan.promise)
    const request = host.call('usage.refresh', { provider: 'codex', force: true })
    await vi.waitFor(() => expect(scanCodexUsageFilesViaWorker).toHaveBeenCalled())
    const released = vi.fn()
    const shutdown = stop().then(released)
    await new Promise((resolve) => setImmediate(resolve))
    expect(released).not.toHaveBeenCalled()
    scan.resolve(codexUsageAggregation.aggregate([event('2026-10-24')]))
    await Promise.all([request, shutdown])
    const restarted = boot()
    expect(
      await restarted.history.getSnapshot('codex', {
        scope: 'all',
        range: 'all',
        includeHistory: true
      })
    ).toMatchObject({
      history: [expect.objectContaining({ sessionId: 'multi-day-session', totalTokens: 1200 })]
    })
  })

  it('starts all four persisted collectors on the Node host, keeping history optional for older clients', async () => {
    const host = boot()
    for (const provider of PROVIDERS) {
      expect(await host.call('usage.setEnabled', { provider, enabled: true })).toMatchObject({
        ok: true,
        result: { enabled: true }
      })
      expect(await host.call('usage.refresh', { provider, force: true })).toMatchObject({
        ok: true,
        result: { lastScanError: null, lastScanCompletedAt: expect.any(Number) }
      })
    }
    const query = { provider: 'codex', scope: 'all', range: 'all', includeHistory: true }
    const first = await host.call('usage.getSnapshot', query)
    expect(first).toMatchObject({
      ok: true,
      result: {
        summary: { totalTokens: 2400 },
        history: [
          expect.objectContaining({
            day: '2026-10-23',
            sessionId: 'multi-day-session',
            newInputTokens: 100,
            cacheReadTokens: 900,
            outputTokens: 200,
            reasoningTokens: 150,
            totalTokens: 1200,
            apiEquivalentCostUsd: expect.any(Number)
          }),
          expect.objectContaining({
            day: '2026-10-24',
            sessionId: 'multi-day-session',
            totalTokens: 1200
          })
        ]
      }
    })
    const compact = await host.call('usage.getSnapshot', {
      provider: 'codex',
      scope: 'all',
      range: 'all'
    })
    expect(compact.ok && compact.result).not.toHaveProperty('history')
    await stop()
    const restarted = boot()
    const scanCount = vi.mocked(scanCodexUsageFilesViaWorker).mock.calls.length
    const persisted = await restarted.call('usage.getSnapshot', query)
    expect(persisted.ok && persisted.result).toEqual(first.ok && first.result)
    expect(scanCodexUsageFilesViaWorker).toHaveBeenCalledTimes(scanCount)
    for (const provider of PROVIDERS) {
      const snapshot = await restarted.history.getSnapshot(provider, {
        scope: 'all',
        range: 'all',
        includeHistory: true
      })
      expect(snapshot.scanState).toMatchObject({
        enabled: true,
        lastScanError: null,
        lastScanCompletedAt: expect.any(Number)
      })
      expect(snapshot.history).toBeDefined()
      expect(snapshot.historyToday).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('retains recorded rows and freshness when an owner refresh fails, and persists that source error', async () => {
    const host = boot()
    await host.call('usage.setEnabled', { provider: 'codex', enabled: true })
    await host.call('usage.refresh', { provider: 'codex', force: true })
    const query = { scope: 'all', range: 'all', includeHistory: true } as const
    const good = await host.history.getSnapshot('codex', query)
    vi.mocked(scanCodexUsageFilesViaWorker).mockRejectedValue(new Error('Fixture source EACCES'))
    expect(await host.call('usage.refresh', { provider: 'codex', force: true })).toMatchObject({
      ok: true,
      result: {
        lastScanError: 'Fixture source EACCES',
        lastScanCompletedAt: good.scanState.lastScanCompletedAt
      }
    })
    await stop()
    const restarted = boot()
    const failed = await restarted.history.getSnapshot('codex', query)
    expect(failed.history).toEqual(good.history)
    expect(failed.scanState).toMatchObject({
      lastScanError: 'Fixture source EACCES',
      lastScanCompletedAt: good.scanState.lastScanCompletedAt
    })
  })

  it('does not scan disabled sources and rejects invalid wire filters before touching collectors', async () => {
    const host = boot()
    expect(await host.call('usage.refresh', { provider: 'codex', force: true })).toMatchObject({
      ok: true,
      result: { enabled: false, lastScanCompletedAt: null }
    })
    expect(scanCodexUsageFilesViaWorker).not.toHaveBeenCalled()
    for (const params of [
      { provider: 'other', scope: 'all', range: 'all' },
      { provider: 'codex', scope: 'all', range: 'all', includeHistory: 'yes' },
      { provider: 'codex', scope: 'all', range: 'all', limit: -1 },
      { provider: 'codex', scope: 'all', range: 'all', owner: 'local' }
    ]) {
      expect(await host.call('usage.getSnapshot', params)).toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
    }
  })
})
