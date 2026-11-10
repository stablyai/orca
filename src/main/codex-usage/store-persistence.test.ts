import { createTestUsageStoreHost } from '../usage/usage-store-host-test-fixture'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { setupCodexUsageStoreEnv } from './store-test-harness'

vi.mock('../usage/usage-scan-worker-spawn', () => ({
  scanCodexUsageFilesViaWorker: vi.fn(),
  splitUsageCacheFileViaWorker: vi.fn()
}))

import { CodexUsageStore } from './store'
import { scanCodexUsageFilesViaWorker } from '../usage/usage-scan-worker-spawn'

describe('CodexUsageStore', () => {
  const storeEnv = setupCodexUsageStoreEnv()

  it('rescans from scratch when the cache predates per-request long-context counts', async () => {
    const scanMock = vi.mocked(scanCodexUsageFilesViaWorker)
    const sourceCachePath = join(storeEnv.tempUserData, 'orca-codex-usage-sources.json')
    const cacheFile = join(storeEnv.tempUserData, 'orca-codex-usage.json')
    const seeded = new CodexUsageStore(
      createTestUsageStoreHost({ userDataPath: storeEnv.tempUserData })
    )
    await seeded.setEnabled(true)
    await seeded.refresh(true)
    await seeded.flush()
    const current = readFileSync(cacheFile, 'utf-8')

    scanMock.mockClear()
    await new CodexUsageStore(
      createTestUsageStoreHost({ userDataPath: storeEnv.tempUserData })
    ).refresh(true)
    expect(scanMock).toHaveBeenLastCalledWith([], {
      path: sourceCachePath,
      schemaVersion: 7,
      worktreeFingerprint: '[]',
      reuse: true
    })

    writeFileSync(cacheFile, JSON.stringify({ ...JSON.parse(current), schemaVersion: 5 }))
    scanMock.mockClear()
    await new CodexUsageStore(
      createTestUsageStoreHost({ userDataPath: storeEnv.tempUserData })
    ).refresh(false)
    expect(scanMock).toHaveBeenLastCalledWith([], {
      path: sourceCachePath,
      schemaVersion: 7,
      worktreeFingerprint: '[]',
      reuse: false
    })
  })
})
