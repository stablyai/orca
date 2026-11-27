import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeTestStores,
  createStore,
  dataFile,
  testState,
  writeDataFile,
  writePersistedStateJson
} from './persistence-test-harness'
import { getDefaultPersistedState } from '../../shared/orca-profiles/constants'
import { profileStateDatabaseFile } from '../../shared/orca-profiles/profile-state-storage-paths'
import { LoadedCohortMigrationOperations } from './loading-store/profile-loading/loaded-cohort-migrations'
import {
  updateAgentHookSettingsFromProfileState,
  updateAgentHookSettingsInProfileState
} from './profile-state/offline-access/profile-state-offline-settings'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const legacyProfile = (settings: Record<string, unknown>) => ({
  schemaVersion: 1,
  repos: [],
  worktreeMeta: {},
  settings,
  ui: {},
  githubCache: { pr: {}, issue: {} },
  workspaceSession: {}
})

describe('composer details default cohort', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-composer-details-default-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('starts off for a new profile, stays off across restart, and keeps an opt-in', async () => {
    const store = createStore()
    expect(store.getSettings().nativeChatComposerDetails).toBe(false)
    await store.flushAsync()
    await closeTestStores()

    const reopened = createStore()
    expect(reopened.getSettings().nativeChatComposerDetails).toBe(false)
    reopened.updateSettings({ nativeChatComposerDetails: true })
    await reopened.flushAsync()
    await closeTestStores()

    expect(createStore().getSettings().nativeChatComposerDetails).toBe(true)
  })

  it('stays on for an existing profile without a choice and keeps an explicit opt-out', async () => {
    writeDataFile(legacyProfile({ theme: 'dark' }))
    const existing = createStore()
    expect(existing.getSettings().nativeChatComposerDetails).toBe(true)
    await existing.flushAsync()
    await closeTestStores()
    expect(createStore().getSettings().nativeChatComposerDetails).toBe(true)
    await closeTestStores()

    writeDataFile(legacyProfile({ nativeChatComposerDetails: false }))
    expect(createStore().getSettings().nativeChatComposerDetails).toBe(false)
  })

  it('keeps the row for an existing profile an offline writer saved, and starts app-created profiles off', async () => {
    // The offline hooks writer spreads default settings over the saved ones before the next load.
    writePersistedStateJson(dataFile(), JSON.stringify(legacyProfile({ theme: 'dark' })))
    updateAgentHookSettingsInProfileState(
      {
        dataFile: dataFile(),
        databaseFile: profileStateDatabaseFile(testState.dir),
        profileId: 'persistence-test'
      },
      true
    )
    const settings = createStore().getSettings()
    expect(settings.agentStatusHooksEnabled).toBe(true)
    expect(settings.nativeChatComposerDetails).toBe(true)

    // initializeNewOrcaProfileState seeds a profile the app creates the same way.
    const cohorts = new LoadedCohortMigrationOperations({ loadNeedsSave: false })
    const created = cohorts.migrateCohortSeeds(getDefaultPersistedState('/home/me'), false)
    expect(created.settings.nativeChatComposerDetails).toBe(false)
  })

  it('starts off for a new install whose first write is the offline hooks command', async () => {
    updateAgentHookSettingsFromProfileState(
      {
        dataFile: dataFile(),
        databaseFile: profileStateDatabaseFile(testState.dir),
        profileId: 'persistence-test'
      },
      true
    )
    const store = createStore()
    expect(store.getSettings().agentStatusHooksEnabled).toBe(true)
    expect(store.getSettings().nativeChatComposerDetails).toBe(false)
    await store.flushAsync()
    await closeTestStores()
    expect(createStore().getSettings().nativeChatComposerDetails).toBe(false)
  })
})
