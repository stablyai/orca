import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { setupCodexUsageStoreEnv } from './store-test-harness'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(() => '/tmp/orca-test-userdata')
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('../usage/usage-scan-worker-spawn', () => ({
  scanCodexUsageFilesViaWorker: vi.fn(),
  splitUsageCacheFileViaWorker: vi.fn()
}))

import { CodexUsageStore } from './store'
import { CODEX_USAGE_SCHEMA_VERSION } from './codex-usage-provider'
import { scanCodexUsageFilesViaWorker } from '../usage/usage-scan-worker-spawn'

describe('CodexUsageStore', () => {
  const storeEnv = setupCodexUsageStoreEnv(getPathMock)

  it('rescans from scratch when the cache predates per-request long-context counts', async () => {
    const scanMock = vi.mocked(scanCodexUsageFilesViaWorker)
    const sourceCachePath = join(storeEnv.tempUserData, 'orca-codex-usage-sources.json')
    const cacheFile = join(storeEnv.tempUserData, 'orca-codex-usage.json')
    const seeded = new CodexUsageStore({ getRepos: () => [], getAllWorktreeMeta: () => ({}) })
    await seeded.setEnabled(true)
    await seeded.refresh(true)
    await seeded.flush()
    const current = readFileSync(cacheFile, 'utf-8')

    scanMock.mockClear()
    await new CodexUsageStore({ getRepos: () => [], getAllWorktreeMeta: () => ({}) }).refresh(true)
    expect(scanMock).toHaveBeenLastCalledWith([], {
      path: sourceCachePath,
      schemaVersion: CODEX_USAGE_SCHEMA_VERSION,
      worktreeFingerprint: '[]',
      reuse: true
    })

    writeFileSync(cacheFile, JSON.stringify({ ...JSON.parse(current), schemaVersion: 5 }))
    scanMock.mockClear()
    await new CodexUsageStore({ getRepos: () => [], getAllWorktreeMeta: () => ({}) }).refresh(false)
    expect(scanMock).toHaveBeenLastCalledWith([], {
      path: sourceCachePath,
      schemaVersion: CODEX_USAGE_SCHEMA_VERSION,
      worktreeFingerprint: '[]',
      reuse: false
    })
  })
})
