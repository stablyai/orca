import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeTestStores, createStore, testState, writeDataFile } from './persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

describe('app rail default cohort', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-app-rail-default-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  const legacyProfile = (settings: Record<string, unknown>) => ({
    schemaVersion: 1,
    repos: [],
    worktreeMeta: {},
    settings,
    ui: {},
    githubCache: { pr: {}, issue: {} },
    workspaceSession: {}
  })

  it('defaults on for a new profile, persists across restart, and keeps an opt-out', async () => {
    const store = createStore()
    expect(store.getSettings().experimentalAppRail).toBe(true)
    await store.flushAsync()
    await closeTestStores()

    const reopened = createStore()
    expect(reopened.getSettings().experimentalAppRail).toBe(true)
    reopened.updateSettings({ experimentalAppRail: false })
    await reopened.flushAsync()
    await closeTestStores()

    const afterOptOut = createStore()
    expect(afterOptOut.getSettings().experimentalAppRail).toBe(false)
  })

  it('stays off for an existing profile without a choice, keeps explicit opt-in, and enables telemetry-only secondary profiles', async () => {
    writeDataFile(legacyProfile({ theme: 'dark' }))
    const existing = createStore()
    expect(existing.getSettings().experimentalAppRail).toBe(false)
    await existing.flushAsync()
    await closeTestStores()
    expect(createStore().getSettings().experimentalAppRail).toBe(false)
    await closeTestStores()

    writeDataFile(legacyProfile({ experimentalAppRail: true }))
    expect(createStore().getSettings().experimentalAppRail).toBe(true)
    await closeTestStores()

    writeDataFile({
      settings: {
        telemetry: {
          optedIn: true,
          existedBeforeTelemetryRelease: true,
          installId: 'install-1'
        }
      }
    })
    expect(createStore().getSettings().experimentalAppRail).toBe(true)
  })
})
