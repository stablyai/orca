import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ClaudeUsagePersistedState } from '../claude-usage/types'
import type { UsageCacheSplitResult } from '../usage/usage-source-cache-file'

const { handlers, getPathMock } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args?: unknown) => unknown>(),
  getPathMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: { getPath: getPathMock },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

vi.mock('../usage/usage-scan-worker-spawn', () => ({
  scanClaudeUsageFilesViaWorker: vi.fn(),
  scanCodexUsageFilesViaWorker: vi.fn(),
  scanOpenCodeUsageDatabasesViaWorker: vi.fn(),
  scanMuseUsageFilesViaWorker: vi.fn(),
  splitUsageCacheFileViaWorker: vi.fn()
}))

import { ClaudeUsageStore, initClaudeUsagePath } from '../claude-usage/store'
import { CodexUsageStore, initCodexUsagePath } from '../codex-usage/store'
import { OpenCodeUsageStore, initOpenCodeUsagePath } from '../opencode-usage/store'
import { MuseUsageStore, initMuseUsagePath } from '../muse-usage/store'
import {
  scanClaudeUsageFilesViaWorker,
  splitUsageCacheFileViaWorker
} from '../usage/usage-scan-worker-spawn'
import { registerUsageProviderHandlers } from './usage-provider-handlers'

let directory: string
let stores: { flush: () => Promise<void> }[]
let releasePending: (() => void)[]

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

function createProviders(): Parameters<typeof registerUsageProviderHandlers>[0] {
  const backingStore = { getRepos: () => [], getAllWorktreeMeta: () => ({}) }
  const providers = {
    claudeUsage: new ClaudeUsageStore(backingStore),
    codexUsage: new CodexUsageStore(backingStore),
    openCodeUsage: new OpenCodeUsageStore(backingStore),
    museUsage: new MuseUsageStore(backingStore)
  }
  stores.push(...Object.values(providers))
  registerUsageProviderHandlers(providers)
  return providers
}

function reportText(state: ClaudeUsagePersistedState): string {
  const { processedFiles: _files, ...report } = state
  return JSON.stringify(report)
}

function invoke(channel: string, args?: unknown): unknown {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`No registered usage handler for ${channel}.`)
  }
  return handler({}, args)
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-usage-ipc-readiness-'))
  stores = []
  releasePending = []
  handlers.clear()
  getPathMock.mockReturnValue(directory)
  vi.mocked(scanClaudeUsageFilesViaWorker).mockReset()
  vi.mocked(splitUsageCacheFileViaWorker).mockReset()
  initClaudeUsagePath()
  initCodexUsagePath()
  initOpenCodeUsagePath()
  initMuseUsagePath()
})

afterEach(async () => {
  releasePending.forEach((release) => release())
  await Promise.all(stores.map((store) => store.flush()))
  rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

it('awaits loading before the first disabled cached snapshot and all historical queries', async () => {
  const cached = historicalState()
  writeFileSync(
    join(directory, 'orca-claude-usage.json'),
    `${JSON.stringify(cached)}${' '.repeat(9 * 1024 * 1024)}`
  )
  const pending = Promise.withResolvers<UsageCacheSplitResult>()
  releasePending.push(() => pending.resolve({ reportText: reportText(cached), migrated: false }))
  vi.mocked(splitUsageCacheFileViaWorker).mockReturnValueOnce(pending.promise)
  const { claudeUsage } = createProviders()
  const snapshotGetter = vi.spyOn(claudeUsage, 'getSnapshot')
  const scanStateGetter = vi.spyOn(claudeUsage, 'getScanState')
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
    Promise.resolve(invoke(`claudeUsage:${query}`, args)).then((value) => {
      settled()
      return value
    })
  )
  await nextTurn()
  expect(settled).not.toHaveBeenCalled()
  expect(snapshotGetter).not.toHaveBeenCalled()
  expect(scanStateGetter).not.toHaveBeenCalled()
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
  expect(snapshotGetter).toHaveBeenCalledWith('all', 'all', 7)
  expect(scanClaudeUsageFilesViaWorker).not.toHaveBeenCalled()
})

it.each(['claudeUsage', 'codexUsage', 'openCodeUsage', 'museUsage'] as const)(
  'gates snapshot and scan state for %s until whenLoaded resolves',
  async (prefix) => {
    const providers = createProviders()
    const store = providers[prefix]
    const pending = Promise.withResolvers<void>()
    releasePending.push(() => pending.resolve(undefined))
    vi.spyOn(store, 'whenLoaded').mockReturnValue(pending.promise)
    const snapshotGetter = vi.spyOn(store, 'getSnapshot')
    const scanStateGetter = vi.spyOn(store, 'getScanState')
    const snapshot = Promise.resolve(
      invoke(`${prefix}:getSnapshot`, { scope: 'all', range: 'all' })
    )
    const scanState = Promise.resolve(invoke(`${prefix}:getScanState`))
    await nextTurn()
    expect(snapshotGetter).not.toHaveBeenCalled()
    expect(scanStateGetter).not.toHaveBeenCalled()
    pending.resolve(undefined)
    await Promise.all([snapshot, scanState])
    expect(snapshotGetter).toHaveBeenCalledWith('all', 'all', undefined)
    expect(scanStateGetter).toHaveBeenCalled()
  }
)

it('keeps a loaded provider snapshot synchronous for direct callers', () => {
  const { codexUsage } = createProviders()
  const loaded = vi.spyOn(codexUsage, 'whenLoaded')
  const snapshot = codexUsage.getSnapshot('all', 'all', 3)
  const scanState = codexUsage.getScanState()
  expect(snapshot).not.toBeInstanceOf(Promise)
  expect(scanState).not.toBeInstanceOf(Promise)
  expect(loaded).not.toHaveBeenCalled()
  expect(snapshot.summary.hasAnyCodexData).toBe(false)
})
