import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createUsageService } from './usage-service'
import { createTestUsageStoreHost } from '../usage/usage-store-host-test-fixture'
import type { ClaudeUsagePersistedState } from '../claude-usage/types'
import type { UsageCacheSplitResult } from '../usage/cache/usage-source-cache-file'
import {
  scanClaudeUsageFilesViaWorker,
  splitUsageCacheFileViaWorker,
  stopUsageScanWorker
} from '../usage/scan-worker/usage-scan-worker-spawn'
vi.mock('../usage/scan-worker/usage-scan-worker-spawn', () => ({
  scanClaudeUsageFilesViaWorker: vi.fn(),
  scanCodexUsageFilesViaWorker: vi.fn(),
  scanOpenCodeUsageDatabasesViaWorker: vi.fn(),
  scanMuseUsageFilesViaWorker: vi.fn(),
  splitUsageCacheFileViaWorker: vi.fn(),
  stopUsageScanWorker: vi.fn(async () => {})
}))
let directory: string
let services: ReturnType<typeof createUsageService>[]
let releasePending: (() => void)[]
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
function reportText(state: ClaudeUsagePersistedState): string {
  const { processedFiles: _files, ...report } = state
  return JSON.stringify(report)
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-backend-usage-'))
  services = []
  releasePending = []
  vi.clearAllMocks()
})
afterEach(async () => {
  releasePending.forEach((release) => release())
  await Promise.all(services.map((service) => service.stop()))
  rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})
function historicalState(): ClaudeUsagePersistedState {
  return {
    schemaVersion: 6,
    worktreeFingerprint: null,
    processedFiles: [],
    sessions: [],
    dailyAggregates: [
      {
        day: '2026-10-09',
        model: null,
        projectKey: 'unscoped',
        projectLabel: 'Unknown location',
        repoId: null,
        worktreeId: null,
        turnCount: 1,
        zeroCacheReadTurnCount: 1,
        inputTokens: 7,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0
      }
    ],
    scanState: {
      enabled: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: 1,
      lastScanError: null
    }
  }
}

it('awaits loading before the first disabled cached snapshot and all historical queries', async () => {
  const cached = historicalState()
  writeFileSync(
    join(directory, 'orca-claude-usage.json'),
    `${JSON.stringify(cached)}${' '.repeat(9 * 1024 * 1024)}`
  )
  const pending = Promise.withResolvers<UsageCacheSplitResult>()
  releasePending.push(() => pending.resolve({ reportText: reportText(cached), migrated: false }))
  vi.mocked(splitUsageCacheFileViaWorker).mockReturnValueOnce(pending.promise)
  const service = createUsageService(createTestUsageStoreHost({ userDataPath: directory }))
  services.push(service)
  const settled = vi.fn()
  const args = { scope: 'all', range: 'all', limit: 7, kind: 'model' }
  const requests = [
    'getSnapshot',
    'getScanState',
    'getSummary',
    'getDaily',
    'getBreakdown',
    'getRecentSessions'
  ].map((query) =>
    Promise.resolve(service.invoke(`claudeUsage:${query}`, args, false)).then((value) => {
      settled()
      return value
    })
  )
  await nextTurn()
  expect(settled).not.toHaveBeenCalled()
  expect(scanClaudeUsageFilesViaWorker).not.toHaveBeenCalled()
  pending.resolve({ reportText: reportText(cached), migrated: false })
  const [snapshot, scanState, summary, daily] = await Promise.all(requests)
  expect(snapshot).toMatchObject({
    scanState: { enabled: false, isScanning: false, hasAnyClaudeData: true },
    summary: { turns: 1, inputTokens: 7 }
  })
  expect(scanState).toMatchObject({ enabled: false, isScanning: false, hasAnyClaudeData: true })
  expect(summary).toMatchObject({ turns: 1, inputTokens: 7 })
  expect(daily).toEqual([
    { day: '2026-10-09', inputTokens: 7, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }
  ])
  expect(scanClaudeUsageFilesViaWorker).not.toHaveBeenCalled()
})

it('retires the scanner before releasing ownership and preserves enabled state without a shutdown error', async () => {
  const service = createUsageService(createTestUsageStoreHost({ userDataPath: directory }))
  services.push(service)
  await service.invoke('claudeUsage:setEnabled', { enabled: true }, false)
  const scanStarted = Promise.withResolvers<void>()
  const scan = Promise.withResolvers<never>()
  vi.mocked(scanClaudeUsageFilesViaWorker).mockImplementationOnce(() => {
    scanStarted.resolve()
    return scan.promise
  })
  const refreshing = service.invoke('claudeUsage:refresh', { force: true }, false)
  await scanStarted.promise
  const retirement = Promise.withResolvers<void>()
  releasePending.push(() => {
    scan.reject(new Error('worker retired'))
    retirement.resolve()
  })
  vi.mocked(stopUsageScanWorker).mockImplementationOnce(() => retirement.promise)
  const stopped = vi.fn()
  const stopping = service.stop().then(stopped)
  await nextTurn()
  expect(stopped).not.toHaveBeenCalled()
  await expect(
    service.invoke('claudeUsage:setEnabled', { enabled: false }, false)
  ).rejects.toThrow()
  scan.reject(new Error('worker retired'))
  retirement.resolve()
  await Promise.all([refreshing, stopping])
  expect(JSON.parse(readFileSync(join(directory, 'orca-claude-usage.json'), 'utf8'))).toMatchObject(
    {
      scanState: { enabled: true, lastScanError: null }
    }
  )
})
