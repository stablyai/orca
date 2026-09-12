import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import { scanCodexUsageFiles } from './scanner'
import { CodexUsageStore, initCodexUsagePath } from './store'
import type { CodexUsagePersistedState } from './types'

export function createEmptyScanResult() {
  return {
    processedFiles: [],
    sessions: [],
    dailyAggregates: []
  }
}

export function createStoreWithState(state: Partial<CodexUsagePersistedState>): CodexUsageStore {
  const store = new CodexUsageStore({
    getRepos: () => [],
    getAllWorktreeMeta: () => ({})
  })

  ;(store as unknown as { state: CodexUsagePersistedState }).state = {
    schemaVersion: 1,
    worktreeFingerprint: null,
    processedFiles: [],
    sessions: [],
    dailyAggregates: [],
    scanState: {
      enabled: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null
    },
    ...state
  }

  return store
}

/** Registers the shared temp-userdata + fake-timer lifecycle; caller owns the hoisted electron mock. */
export function setupCodexUsageStoreEnv(getPathMock: Mock): { tempUserData: string } {
  const env = { tempUserData: '' }

  beforeEach(() => {
    env.tempUserData = mkdtempSync(join(tmpdir(), 'orca-codex-usage-store-'))
    getPathMock.mockReturnValue(env.tempUserData)
    initCodexUsagePath()
    vi.mocked(scanCodexUsageFiles).mockReset()
    vi.mocked(scanCodexUsageFiles).mockResolvedValue(createEmptyScanResult())
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-10T12:00:00.000-04:00'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(env.tempUserData, { recursive: true, force: true })
  })

  return env
}
