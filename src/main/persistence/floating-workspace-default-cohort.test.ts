import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeTestStores,
  createStore,
  dataFile,
  makeRepo,
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
import { migrateProfileProjectTransferParticipant } from '../orca-profiles/project-transfer/profile-project-transfer-migration'
import { normalizeProfileProjectState } from '../orca-profiles/project-transfer/profile-project-state-file'
import { sanitizeRendererSettingsUpdate } from '../ipc/settings/renderer-settings-update'
import { openProfileStateDatabase } from './profile-state/database/profile-state-database'
import { ProfileStateRevisionConflictError } from './profile-state/documents/profile-state-document-validation'
import { newProfileSeededState } from './loading-store/profile-loading/new-profile-cohort-seeds'
import type * as DomainReader from './profile-state/documents/profile-state-domain-reader'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const race = vi.hoisted(() => {
  const hook: { afterOfflineRead: (() => void) | null } = { afterOfflineRead: null }
  return hook
})

// Lets a test commit the startup's first save between the offline writer's read and its write.
vi.mock('./profile-state/documents/profile-state-domain-reader', async (importActual) => {
  const actual = await importActual<typeof DomainReader>()
  return {
    ...actual,
    readProfileStateDomainsWithRevisionFromDatabase: (
      ...args: Parameters<typeof actual.readProfileStateDomainsWithRevisionFromDatabase>
    ) => {
      const result = actual.readProfileStateDomainsWithRevisionFromDatabase(...args)
      const interleave = race.afterOfflineRead
      race.afterOfflineRead = null
      interleave?.()
      return result
    }
  }
})

const TELEMETRY_ONLY = {
  settings: {
    telemetry: { optedIn: true, existedBeforeTelemetryRelease: true, installId: 'install-1' }
  }
}

const legacyProfile = (settings: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  repos: [],
  worktreeMeta: {},
  settings,
  ui: {},
  githubCache: { pr: {}, issue: {} },
  workspaceSession: {},
  ...extra
})

const offlineLocation = () => ({
  dataFile: dataFile(),
  databaseFile: profileStateDatabaseFile(testState.dir),
  profileId: 'persistence-test'
})

async function loadedCohort(): Promise<[boolean | undefined, boolean]> {
  const settings = createStore().getSettings()
  const result: [boolean | undefined, boolean] = [
    settings.floatingWorkspaceInSettings,
    settings.floatingTerminalEnabled
  ]
  await closeTestStores()
  return result
}

describe('floating workspace default cohort', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-floating-cohort-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('starts new profiles hidden and off, and keeps that across restarts', async () => {
    const store = createStore()
    await store.flushAsync()
    await closeTestStores()
    expect(await loadedCohort()).toEqual([false, false])
    initializeNewOrcaProfileState('created', undefined, testState.dir)
    const created = readPersistedState(getOrcaProfileDataFile('created', testState.dir), 'created')
    expect(created.settings.floatingWorkspaceInSettings).toBe(false)
    expect(created.settings.floatingTerminalEnabled).toBe(false)
  })

  it('keeps existing profiles in Settings with their saved choice', async () => {
    writeDataFile(
      legacyProfile({ floatingTerminalDefaultedForAllUsers: true, floatingTerminalEnabled: false })
    )
    expect(await loadedCohort()).toEqual([true, false])
    rmSync(testState.dir, { recursive: true, force: true })
    writeDataFile(legacyProfile({ floatingTerminalDefaultedForAllUsers: true }))
    expect(await loadedCohort()).toEqual([true, true])
    rmSync(testState.dir, { recursive: true, force: true })
    // Unstamped existing profiles keep the old one-shot flip to on.
    writeDataFile(legacyProfile({ theme: 'dark', floatingTerminalEnabled: false }))
    expect(await loadedCohort()).toEqual([true, true])
  })

  it('treats a never-loaded telemetry-only profile as new', async () => {
    writeDataFile(TELEMETRY_ONLY)
    expect(await loadedCohort()).toEqual([false, false])
  })

  it('seeds new profiles before an offline write expands their settings', async () => {
    updateAgentHookSettingsFromProfileState(offlineLocation(), true)
    expect(await loadedCohort()).toEqual([false, false])
    rmSync(testState.dir, { recursive: true, force: true })

    writeDataFile(TELEMETRY_ONLY)
    updateAgentHookSettingsFromProfileState(offlineLocation(), true)
    const settings = createStore().getSettings()
    expect(settings.floatingWorkspaceInSettings).toBe(false)
    expect(settings.floatingTerminalEnabled).toBe(false)
    expect(settings.nativeChatMarkNewMessages).toBe(false)
  })

  it('keeps an existing root with telemetry-only settings existing', async () => {
    writeDataFile({ ...TELEMETRY_ONLY, repos: [makeRepo()], ui: { sidebarWidth: 300 } })
    updateAgentHookSettingsFromProfileState(offlineLocation(), true)
    expect((await loadedCohort())[0]).toBe(true)
  })

  it('keeps an unstamped existing profile on after an offline defaults spread', async () => {
    writeDataFile(legacyProfile({ theme: 'dark' }))
    updateAgentHookSettingsFromProfileState(offlineLocation(), true)
    expect(await loadedCohort()).toEqual([true, true])
  })

  it('seeds a provably empty SQLite authority', async () => {
    // A fresh startup leaves an empty revision-zero database before its first write.
    openProfileStateDatabase(profileStateDatabaseFile(testState.dir), 'persistence-test').db.close()
    updateAgentHookSettingsInProfileState(offlineLocation(), true)
    expect(await loadedCohort()).toEqual([false, false])
  })

  it('rejects an offline write that raced the first save, and its retry keeps the new cohort', async () => {
    openProfileStateDatabase(profileStateDatabaseFile(testState.dir), 'persistence-test').db.close()
    // The startup's first save commits through its own connection after the writer saw revision 0.
    race.afterOfflineRead = () =>
      writePersistedStateJson(
        dataFile(),
        JSON.stringify({
          ...newProfileSeededState(),
          settings: { ...newProfileSeededState().settings, theme: 'light' }
        })
      )
    expect(() => updateAgentHookSettingsInProfileState(offlineLocation(), true)).toThrow(
      ProfileStateRevisionConflictError
    )
    updateAgentHookSettingsInProfileState(offlineLocation(), true)
    const settings = createStore().getSettings()
    expect(settings.floatingWorkspaceInSettings).toBe(false)
    expect(settings.floatingTerminalEnabled).toBe(false)
    expect(settings.theme).toBe('light')
    expect(settings.agentStatusHooksEnabled).toBe(true)
  })

  it('seeds a project-transfer target that has no state or only telemetry', () => {
    migrateProfileProjectTransferParticipant('target', testState.dir, {
      state: normalizeProfileProjectState({})
    })
    const target = readPersistedState(getOrcaProfileDataFile('target', testState.dir), 'target')
    expect(target.settings.floatingWorkspaceInSettings).toBe(false)
    expect(target.settings.floatingTerminalEnabled).toBe(false)

    // Inactive-profile JSON arrives untyped, exactly as the transfer reader parses it.
    const fromJson = (root: unknown) =>
      normalizeProfileProjectState(JSON.parse(JSON.stringify(root)))
    expect(fromJson(TELEMETRY_ONLY).settings.floatingWorkspaceInSettings).toBe(false)
    expect(
      fromJson({ ...TELEMETRY_ONLY, repos: [makeRepo()] }).settings.floatingWorkspaceInSettings
    ).toBeUndefined()
  })

  it('never accepts the main-owned keys from a renderer update', () => {
    expect(
      sanitizeRendererSettingsUpdate({
        floatingWorkspaceInSettings: true,
        floatingTerminalDefaultedForAllUsers: false,
        floatingTerminalEnabled: true
      })
    ).toEqual({ floatingTerminalEnabled: true })
  })
})
