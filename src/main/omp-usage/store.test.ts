import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(() => '/tmp/orca-omp-usage-test-userdata')
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('../usage/usage-scan-worker-spawn', () => ({
  scanOmpUsageFilesViaWorker: vi.fn(),
  splitUsageCacheFileViaWorker: vi.fn()
}))

import { scanOmpUsageFilesViaWorker } from '../usage/usage-scan-worker-spawn'
import {
  getDefaultOmpUsageState,
  initOmpUsagePath,
  normalizePersistedState,
  OmpUsageStore
} from './store'
import type { OmpUsagePersistedState } from './types'

describe('OmpUsageStore', () => {
  let tempUserData: string

  beforeEach(async () => {
    tempUserData = await mkdtemp(join(tmpdir(), 'orca-omp-usage-store-'))
    getPathMock.mockReturnValue(tempUserData)
    initOmpUsagePath()
    vi.mocked(scanOmpUsageFilesViaWorker).mockReset()
    vi.mocked(scanOmpUsageFilesViaWorker).mockResolvedValue({ sessions: [], dailyAggregates: [] })
  })

  afterEach(async () => {
    await rm(tempUserData, { recursive: true, force: true })
  })

  function createStore(): OmpUsageStore {
    return new OmpUsageStore({ getRepos: () => [], getAllWorktreeMeta: () => ({}) })
  }

  it('starts disabled with schema version 1 and no datapoints', async () => {
    const store = createStore()

    expect(store.id).toBe('omp')
    expect(store.label).toBe('omp')
    expect(getDefaultOmpUsageState().schemaVersion).toBe(1)
    expect(store.getScanState()).toEqual({
      enabled: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null,
      isScanning: false,
      hasAnyOmpData: false
    })
  })

  it('scans omp session files on the usage worker and persists the report', async () => {
    const store = createStore()
    await store.setEnabled(true)
    await store.refresh(true)

    // Resolution: every history scan runs on the worker, never on main.
    expect(scanOmpUsageFilesViaWorker).toHaveBeenCalledWith([], {
      path: join(tempUserData, 'orca-omp-usage-sources.json'),
      schemaVersion: 1,
      worktreeFingerprint: '[]',
      reuse: false
    })

    const persisted = JSON.parse(
      await readFile(join(tempUserData, 'orca-omp-usage.json'), 'utf-8')
    ) as Record<string, unknown>
    expect(persisted).toMatchObject({ schemaVersion: 1, sessions: [], dailyAggregates: [] })
    expect(persisted).not.toHaveProperty('processedFiles')
    await store.flush()
  })

  it('drops persisted caches from older schemas while preserving the enabled preference', () => {
    const defaults = getDefaultOmpUsageState()
    const legacy: OmpUsagePersistedState = {
      schemaVersion: 0,
      worktreeFingerprint: 'legacy',
      processedFiles: [
        {
          path: '/legacy/session.jsonl',
          mtimeMs: 1,
          size: 2,
          sessions: [],
          dailyAggregates: []
        }
      ],
      sessions: [],
      dailyAggregates: [],
      scanState: {
        enabled: true,
        lastScanStartedAt: 1,
        lastScanCompletedAt: 2,
        lastScanError: 'boom'
      }
    }

    expect(normalizePersistedState(legacy)).toEqual({
      ...defaults,
      scanState: { ...defaults.scanState, enabled: true }
    })
  })
})
