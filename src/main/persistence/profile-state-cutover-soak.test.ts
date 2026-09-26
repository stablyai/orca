import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildProfileStateCutoverFixture,
  canonicalProfileStateJson
} from './profile-state-cutover-fixture'
import {
  readAgentHookSettingsFromProfileState,
  updateAgentHookSettingsInProfileState,
  type ProfileStateOfflineLocation
} from './profile-state/profile-state-offline-settings'
import {
  createProfileStateStore,
  type ProfileStateStoreFactoryOptions,
  type ProfileStateStoreFactoryResult
} from './profile-state/profile-state-store-factory'
import { profileStateDatabaseFile } from './profile-state/profile-state-database'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').slice('encrypted:'.length)
  },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../../telemetry/client', () => ({ track: () => {} }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const { Store } = await import('./loading-store/store')

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

type MigratedProfile = {
  options: ProfileStateStoreFactoryOptions
  location: ProfileStateOfflineLocation
  first: ProfileStateStoreFactoryResult
}

function createProfile(profileId: string, theme: string): MigratedProfile {
  const directory = mkdtempSync(join(tmpdir(), `orca-profile-state-cutover-${profileId}-`))
  temporaryDirectories.push(directory)
  const dataFile = join(directory, 'orca-data.json')
  const databaseFile = profileStateDatabaseFile(directory)
  const fixture = buildProfileStateCutoverFixture(directory)
  writeFileSync(
    dataFile,
    JSON.stringify({
      ...fixture,
      settings: { ...fixture.settings, theme },
      // Keep enough unrelated data to make repeated complete-document commits meaningful.
      soakExtension: { bytes: 'x'.repeat(96 * 1024), nullable: null }
    })
  )
  const options: ProfileStateStoreFactoryOptions = {
    dataFile,
    databaseFile,
    profileId,
    authorityMode: 'sqlite-candidate'
  }
  const first = createProfileStateStore(options)
  expect(first.backend).toBe('sqlite')
  expect(first.migrated).toBe(true)
  return {
    options,
    location: { dataFile, databaseFile, profileId },
    first
  }
}

function removeLegacyJson(profile: MigratedProfile): void {
  profile.first.store.freezeWrites()
  rmSync(profile.options.dataFile, { force: true })
  expect(existsSync(profile.options.dataFile)).toBe(false)
  expect(existsSync(profile.options.databaseFile)).toBe(true)
}

function reopen(profile: MigratedProfile): ProfileStateStoreFactoryResult {
  return createProfileStateStore(profile.options)
}

function exportJson(store: ProfileStateStoreFactoryResult['store']): unknown {
  return JSON.parse(store.prepareProfileStateExport().json)
}

describe('profile-state candidate cutover soak', () => {
  it('keeps the retained JSON export usable for legacy rollback', () => {
    const profile = createProfile('rollback-window', 'light')
    const retainedJson = readFileSync(profile.options.dataFile)

    profile.first.store.updateSettings({ theme: 'dark', terminalFontSize: 123 })
    profile.first.store.flushOrThrow()
    expect(readFileSync(profile.options.dataFile)).toEqual(retainedJson)

    const legacyStore = new Store({ dataFile: profile.options.dataFile })
    expect(legacyStore.getSettings().theme).toBe('light')
    expect(legacyStore.getSettings().terminalFontSize).not.toBe(123)
    legacyStore.freezeWrites()
    profile.first.store.freezeWrites()
  })

  it('migrates a complete profile, removes JSON, and survives restart/domain/offline churn', () => {
    const profile = createProfile('soak-primary', 'light')
    const initial = exportJson(profile.first.store)
    const folderGroup = profile.first.store.createProjectGroup({
      name: 'Fixture folders',
      createdFrom: 'manual',
      parentPath: '/fixture/folder',
      connectionId: 'build-host'
    })
    const folderWorkspace = profile.first.store.createFolderWorkspace({
      projectGroupId: folderGroup.id,
      name: 'Remote folder fixture',
      folderPath: '/fixture/folder',
      connectionId: 'build-host'
    })
    const remoteAutomation = profile.first.store.createAutomation({
      name: 'Remote fixture automation',
      prompt: 'Keep the remote fixture valid',
      agentId: 'claude',
      projectId: 'repo-remote',
      workspaceMode: 'existing',
      workspaceId: 'repo-remote::/fixture/remote',
      baseBranch: null,
      reuseSession: false,
      timezone: 'UTC',
      rrule: 'FREQ=DAILY',
      dtstart: 10,
      enabled: true,
      missedRunGraceMinutes: 5
    })
    profile.first.store.createAutomationRun(remoteAutomation, 30, 'manual')
    profile.first.store.flushOrThrow()
    removeLegacyJson(profile)

    for (let round = 0; round < 8; round += 1) {
      const reopened = reopen(profile)
      const currentSession = reopened.store.getWorkspaceSession()
      const currentAutomation = reopened.store.listAutomations()[0]
      if (!currentAutomation) {
        throw new Error('cutover fixture lost its automation')
      }

      reopened.store.updateSettings({
        theme: round % 2 === 0 ? 'dark' : 'light',
        terminalFontSize: reopened.store.getSettings().terminalFontSize + 1
      })
      reopened.store.updateUI({ activeView: round % 2 === 0 ? 'tasks' : 'terminal' })
      reopened.store.patchWorkspaceSession({
        browserUrlHistory: [
          ...(currentSession.browserUrlHistory ?? []),
          {
            url: `https://fixture.test/soak/${round}`,
            normalizedUrl: `https://fixture.test/soak/${round}`,
            title: `Soak ${round}`,
            lastVisitedAt: round + 10,
            visitCount: 1
          }
        ]
      })
      reopened.store.setWorktreeMeta('repo-local::/fixture/local', {
        comment: `soak-${round}`,
        linkedPR: 100 + round
      })
      reopened.store.createAutomationRun(currentAutomation, 100 + round, 'manual')
      reopened.store.flushOrThrow()
      reopened.store.freezeWrites()

      const restarted = reopen(profile)
      expect(restarted.store.getWorkspaceSession().activeTabId).toBe('tab-local')
      expect(restarted.store.getWorkspaceSession('ssh:build-host').activeTabId).toBe('tab-remote')
      expect(restarted.store.getFolderWorkspace(folderWorkspace.id)).toMatchObject({
        name: 'Remote folder fixture',
        folderPath: '/fixture/folder',
        connectionId: 'build-host'
      })
      expect(restarted.store.getWorktreeMeta('repo-local::/fixture/local')).toMatchObject({
        comment: `soak-${round}`,
        linkedPR: 100 + round
      })
      expect(restarted.store.listAutomationRuns('automation-fixture').length).toBeGreaterThan(
        round + 1
      )
      const persistedRemoteAutomation = restarted.store
        .listAutomations()
        .find((automation) => automation.id === remoteAutomation.id)
      expect(persistedRemoteAutomation).toMatchObject({
        executionTargetType: 'ssh',
        executionTargetId: 'build-host',
        schedulerOwner: 'ssh_bridge',
        workspaceId: 'repo-remote::/fixture/remote'
      })
      expect(
        restarted.store
          .listAutomationRuns(remoteAutomation.id)
          .some((run) => run.trigger === 'manual')
      ).toBe(true)
      restarted.store.freezeWrites()
    }

    const beforeOffline = readAgentHookSettingsFromProfileState(profile.location)
    const offlineUpdate = updateAgentHookSettingsInProfileState(profile.location, false)
    expect(offlineUpdate.settingsPath).toBe(profile.options.databaseFile)
    expect(readAgentHookSettingsFromProfileState(profile.location).agentStatusHooksEnabled).toBe(
      false
    )

    const afterOffline = reopen(profile)
    const persisted = exportJson(afterOffline.store)
    expect(afterOffline.store.getSettings().agentStatusHooksEnabled).toBe(false)
    expect(afterOffline.store.getSettings().opencodeSessionCookie).toBe('fixture-secret')
    expect(afterOffline.store.getWorkspaceSession('ssh:build-host').activeTabId).toBe('tab-remote')
    expect(afterOffline.store.getFolderWorkspace(folderWorkspace.id)).toMatchObject({
      folderPath: '/fixture/folder',
      connectionId: 'build-host'
    })
    expect(afterOffline.store.listAutomationRuns('automation-fixture').length).toBeGreaterThan(8)
    expect(
      afterOffline.store
        .listAutomations()
        .find((automation) => automation.id === remoteAutomation.id)
    ).toMatchObject({
      executionTargetType: 'ssh',
      executionTargetId: 'build-host',
      schedulerOwner: 'ssh_bridge'
    })
    expect(afterOffline.store.listAutomationRuns(remoteAutomation.id)).toHaveLength(1)
    expect(persisted).toHaveProperty('soakExtension', {
      bytes: 'x'.repeat(96 * 1024),
      nullable: null
    })
    expect(beforeOffline.agentStatusHooksEnabled).toBe(true)
    expect(existsSync(profile.options.dataFile)).toBe(false)
    expect(canonicalProfileStateJson(persisted)).not.toBe(canonicalProfileStateJson(initial))
    afterOffline.store.freezeWrites()
  })

  it('switches between independent SQLite profiles without crossing state', () => {
    const first = createProfile('switch-first', 'dark')
    const second = createProfile('switch-second', 'light')
    removeLegacyJson(first)
    removeLegacyJson(second)
    const firstInitial = reopen(first)
    const firstInitialFontSize = firstInitial.store.getSettings().terminalFontSize
    firstInitial.store.freezeWrites()
    const secondInitial = reopen(second)
    const secondInitialFontSize = secondInitial.store.getSettings().terminalFontSize
    secondInitial.store.freezeWrites()

    for (let round = 0; round < 6; round += 1) {
      const active = round % 2 === 0 ? first : second
      const inactive = active === first ? second : first
      const activeStore = reopen(active)
      activeStore.store.updateSettings({
        theme: active === first ? 'dark' : 'light',
        terminalFontSize: (active === first ? 100 : 200) + round
      })
      activeStore.store.flushOrThrow()
      activeStore.store.freezeWrites()

      const inactiveStore = reopen(inactive)
      expect(inactiveStore.store.getSettings().terminalFontSize).toBe(
        round === 0
          ? inactive === first
            ? firstInitialFontSize
            : secondInitialFontSize
          : (inactive === first ? 100 : 200) + round - 1
      )
      expect(inactiveStore.store.getWorkspaceSession().activeTabId).toBe('tab-local')
      inactiveStore.store.freezeWrites()
    }

    const firstFinal = reopen(first)
    const secondFinal = reopen(second)
    expect(firstFinal.store.getSettings().terminalFontSize).toBe(104)
    expect(secondFinal.store.getSettings().terminalFontSize).toBe(205)
    expect(firstFinal.store.getSettings().opencodeSessionCookie).toBe('fixture-secret')
    expect(secondFinal.store.getSettings().opencodeSessionCookie).toBe('fixture-secret')
    firstFinal.store.freezeWrites()
    secondFinal.store.freezeWrites()
  })

  it('allows one stale complete-document writer and rejects the rest', () => {
    const profile = createProfile('soak-cas', 'light')
    removeLegacyJson(profile)
    const staleWriters = Array.from({ length: 7 }, () => reopen(profile))

    for (const [index, writer] of staleWriters.entries()) {
      writer.store.updateSettings({
        theme: index % 2 === 0 ? 'dark' : 'light',
        terminalFontSize: 100 + index
      })
    }

    let commits = 0
    let conflicts = 0
    for (const writer of staleWriters) {
      try {
        writer.store.flushOrThrow()
        commits += 1
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'profile-state-revision-conflict'
        ) {
          conflicts += 1
        } else {
          throw error
        }
      } finally {
        writer.store.freezeWrites()
      }
    }

    expect(commits).toBe(1)
    expect(conflicts).toBe(staleWriters.length - 1)
    const verifier = reopen(profile)
    expect(verifier.store.getSettings().terminalFontSize).toBe(100)
    expect(verifier.store.getSettings().opencodeSessionCookie).toBe('fixture-secret')
    expect(verifier.store.getWorkspaceSession('ssh:build-host').activeTabId).toBe('tab-remote')
    expect(readFileSync(profile.options.databaseFile)).toBeTruthy()
    verifier.store.freezeWrites()
  })
})
