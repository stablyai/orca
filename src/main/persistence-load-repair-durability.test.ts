/**
 * Load-time normalization repairs the in-memory state; without a matching dirty mark the bad value
 * stays on disk and the repair reruns on every launch. Each case here reloads a profile the current
 * build already settled, so the field under test is the only unrepaired key left.
 * Why no flush(): flush() writes unconditionally, so only the debounced load-path save proves the
 * repair marked the state dirty by itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../shared/persisted-state-types'
import { testState, createStore, writeDataFile, readDataFile } from './persistence-test-harness'

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))
const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => false
  }
}))

vi.mock('./telemetry/client', () => ({
  track: trackMock
}))

vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

/** A profile this build has already loaded and written, so no unrelated migration is still pending. */
async function settledProfile(): Promise<PersistedState> {
  writeDataFile({
    schemaVersion: 1,
    repos: [],
    worktreeMeta: {},
    settings: {},
    ui: {},
    githubCache: { pr: {}, issue: {} },
    workspaceSession: {}
  })
  const store = await createStore()
  store.flush()
  return readDataFile() as PersistedState
}

/** Reload without mutating, letting only the load-path debounce write. */
async function reloadAndSettleWrites(): Promise<PersistedState> {
  vi.useFakeTimers()
  try {
    const store = await createStore()
    // Why over-advance: an exact-fit advance turns a future debounce raise into a confusing no-write.
    vi.advanceTimersByTime(5000)
    await store.waitForPendingWrite()
  } finally {
    vi.useRealTimers()
  }
  return readDataFile() as PersistedState
}

describe('load-time normalization durability', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('persists the legacy search-tab explorer view repair', async () => {
    const settled = await settledProfile()
    // The legacy shape: Search was a standalone activity tab with no explorer view.
    delete (settled.ui as Record<string, unknown>).rightSidebarExplorerView
    settled.ui.rightSidebarTab = 'search'
    writeDataFile(settled)

    const persisted = await reloadAndSettleWrites()

    expect(persisted.ui.rightSidebarExplorerView).toBe('search')
  })

  it('persists a repaired notification settings block', async () => {
    const settled = await settledProfile()
    settled.settings.notifications = {
      ...settled.settings.notifications,
      enabled: 'false' as unknown as boolean
    }
    writeDataFile(settled)

    const persisted = await reloadAndSettleWrites()

    expect(persisted.settings.notifications.enabled).toBe(true)
  })
})
