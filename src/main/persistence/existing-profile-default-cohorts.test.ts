import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeChatMarksNewMessages } from '../../shared/native-chat/settings/native-chat-appearance-settings'
import {
  closeTestStores,
  createStore,
  dataFile,
  readPersistedState,
  testState,
  writeDataFile,
  writePersistedStateJson
} from './persistence-test-harness'
import { profileStateDatabaseFile } from '../../shared/orca-profiles/profile-state-storage-paths'
import {
  updateAgentHookSettingsFromProfileState,
  updateAgentHookSettingsInProfileState
} from './profile-state/offline-access/profile-state-offline-settings'
import { initializeNewOrcaProfileState } from '../orca-profiles/storage/new-profile-state'
import { getOrcaProfileDataFile } from '../orca-profiles/profile-storage-paths'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

describe('existing-profile default cohorts', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-default-cohorts-'))
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

  it('marks new chat messages only for existing profiles without a choice', async () => {
    const fresh = createStore()
    expect(nativeChatMarksNewMessages(fresh.getSettings())).toBe(false)
    await fresh.flushAsync()
    await closeTestStores()
    expect(nativeChatMarksNewMessages(createStore().getSettings())).toBe(false)
    await closeTestStores()

    writeDataFile(legacyProfile({ theme: 'dark' }))
    const existing = createStore()
    expect(nativeChatMarksNewMessages(existing.getSettings())).toBe(true)
    await existing.flushAsync()
    await closeTestStores()
    expect(nativeChatMarksNewMessages(createStore().getSettings())).toBe(true)
    await closeTestStores()

    writeDataFile(legacyProfile({ nativeChatMarkNewMessages: false }))
    expect(nativeChatMarksNewMessages(createStore().getSettings())).toBe(false)
  })

  it('keeps New messages on for an existing profile after an offline write that spreads defaults', async () => {
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
    expect(nativeChatMarksNewMessages(settings)).toBe(true)
  })

  it('starts New messages off for profiles created before their first load', async () => {
    initializeNewOrcaProfileState('created', undefined, testState.dir)
    expect(
      readPersistedState(getOrcaProfileDataFile('created', testState.dir), 'created').settings
        .nativeChatMarkNewMessages
    ).toBe(false)

    updateAgentHookSettingsFromProfileState(
      {
        dataFile: dataFile(),
        databaseFile: profileStateDatabaseFile(testState.dir),
        profileId: 'persistence-test'
      },
      true
    )
    expect(nativeChatMarksNewMessages(createStore().getSettings())).toBe(false)
  })
})
