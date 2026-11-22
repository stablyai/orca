import {
  closeTestStores,
  testState,
  createStore,
  makeRepo,
  makeWorkspaceLineage
} from '../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, readFileSync, rmSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProfileStateStore } from '../profile-state/startup/profile-state-store-factory'
import { ProfileStateAuthorityBootstrapError } from '../profile-state/recovery/profile-state-recovery-required'
import { restoreProfileStateJsonExport } from '../profile-state/legacy-json/profile-state-recovery'
import { acquireProfileStateMaintenance } from '../profile-state/access/profile-state-access'
import {
  folderWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../shared/workspace/identity/workspace-scope'

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('../../ssh/config/ssh-config-parser', () => ({
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
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
  }
}))

vi.mock('../../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('Store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('removeFolderWorkspace deletes child workspace lineage for that folder parent', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({
      name: 'Platform',
      parentPath: '/workspace/platform',
      createdFrom: 'folder-scan'
    })
    const workspace = store.createFolderWorkspace({
      projectGroupId: group.id,
      name: 'Folder parent'
    })
    const folderLineage = makeWorkspaceLineage({
      parentWorkspaceKey: folderWorkspaceKey(workspace.id)
    })
    const unrelatedLineage = makeWorkspaceLineage({
      childWorkspaceKey: worktreeWorkspaceKey('r2::/other-child'),
      parentWorkspaceKey: folderWorkspaceKey('other-folder')
    })

    store.setWorkspaceLineage(folderLineage)
    store.setWorkspaceLineage(unrelatedLineage)

    store.removeFolderWorkspace(workspace.id)

    expect(store.getWorkspaceLineage(folderLineage.childWorkspaceKey)).toBeUndefined()
    expect(store.getWorkspaceLineage(unrelatedLineage.childWorkspaceKey)).toEqual(unrelatedLineage)
  })

  describe('mobileClientTabSelectionsByDeviceId', () => {
    it('prunes selections for a removed repo worktree', async () => {
      const store = await createStore()
      store.addRepo(makeRepo())
      store.addRepo(makeRepo({ id: 'other-repo', path: '/other-repo' }))
      store.setMobileClientTabSelections({
        'device-a': {
          'r1::/tmp/wt': {
            activeTabId: 'tab-1',
            activeGroupId: null,
            activeTabIdByGroupId: {}
          },
          'other-repo::/tmp/wt': {
            activeTabId: 'tab-2',
            activeGroupId: null,
            activeTabIdByGroupId: {}
          }
        }
      })

      store.removeProjectForHost({ id: 'r1', executionHostId: 'local' })
      store.flush()

      expect(store.getMobileClientTabSelections()['device-a']).toEqual({
        'other-repo::/tmp/wt': {
          activeTabId: 'tab-2',
          activeGroupId: null,
          activeTabIdByGroupId: {}
        }
      })
      const reloaded = await createStore()
      expect(reloaded.getMobileClientTabSelections()['device-a']).toEqual({
        'other-repo::/tmp/wt': {
          activeTabId: 'tab-2',
          activeGroupId: null,
          activeTabIdByGroupId: {}
        }
      })
    })

    it('prunes selections when a folder workspace is removed directly or with its group', async () => {
      const store = await createStore()
      const directGroup = store.createProjectGroup({
        name: 'Direct',
        parentPath: '/tmp/direct',
        createdFrom: 'manual'
      })
      const directWorkspace = store.createFolderWorkspace({
        projectGroupId: directGroup.id,
        name: 'Direct workspace'
      })
      const cascadeGroup = store.createProjectGroup({
        name: 'Cascade',
        parentPath: '/tmp/cascade',
        createdFrom: 'manual'
      })
      const cascadeWorkspace = store.createFolderWorkspace({
        projectGroupId: cascadeGroup.id,
        name: 'Cascade workspace'
      })
      store.setMobileClientTabSelections({
        'device-a': {
          [folderWorkspaceKey(directWorkspace.id)]: {
            activeTabId: 'tab-direct',
            activeGroupId: null,
            activeTabIdByGroupId: {}
          },
          [folderWorkspaceKey(cascadeWorkspace.id)]: {
            activeTabId: 'tab-cascade',
            activeGroupId: null,
            activeTabIdByGroupId: {}
          }
        }
      })

      store.removeFolderWorkspace(directWorkspace.id)
      store.deleteProjectGroup(cascadeGroup.id)
      store.flush()

      const reloaded = await createStore()
      expect(reloaded.getMobileClientTabSelections()).toEqual({})
    })
  })

  describe('legacy backup import and recovery', () => {
    const recoveredStores: ReturnType<typeof createProfileStateStore>['store'][] = []
    afterEach(async () => {
      await Promise.all(recoveredStores.splice(0).map((store) => store.freezeWritesAsync()))
    })

    function recoveryOptions() {
      const directory = join(testState.dir, 'profiles', 'recovery-test')
      mkdirSync(directory, { recursive: true })
      return {
        dataFile: join(directory, 'orca-data.json'),
        databaseFile: join(directory, 'profile-state.db'),
        profileId: 'recovery-test'
      }
    }

    function importRecoveredProfile(options: ReturnType<typeof recoveryOptions>) {
      const { store } = createProfileStateStore(options)
      recoveredStores.push(store)
      return store
    }

    function restoreSelectedBackup(options: ReturnType<typeof recoveryOptions>, index: number) {
      expect(() => createProfileStateStore(options)).toThrow(ProfileStateAuthorityBootstrapError)
      const maintenance = acquireProfileStateMaintenance(testState.dir)
      try {
        restoreProfileStateJsonExport({
          ...options,
          databasePath: options.databaseFile,
          exportPath: `${options.dataFile}.bak.${index}`,
          maintenance
        })
      } finally {
        maintenance.release()
      }
      return importRecoveredProfile(options)
    }

    it.each([
      { primary: 'corrupt', index: 0, repoId: 'recovered' },
      { primary: 'corrupt', index: 1, repoId: 'from-bak1' },
      { primary: 'missing', index: 0, repoId: 'rescued' }
    ] as const)('imports backup $index with a $primary primary', (scenario) => {
      const options = recoveryOptions()
      if (scenario.primary === 'corrupt') {
        writeFileSync(options.dataFile, '{{corrupt')
      }
      if (scenario.index === 1) {
        writeFileSync(`${options.dataFile}.bak.0`, '{{also-corrupt')
      }
      const backup = `${options.dataFile}.bak.${scenario.index}`
      const retained = JSON.stringify({ repos: [makeRepo({ id: scenario.repoId })] })
      writeFileSync(backup, retained)
      const store =
        scenario.primary === 'missing'
          ? restoreSelectedBackup(options, scenario.index)
          : importRecoveredProfile(options)
      expect(store.getRepos().map((repo) => repo.id)).toEqual([scenario.repoId])
      expect(readFileSync(backup, 'utf8')).toBe(retained)
      if (scenario.primary === 'corrupt') {
        expect(readFileSync(options.dataFile, 'utf8')).toBe('{{corrupt')
      }
    })

    it('refuses defaults when the primary and every backup are unusable', () => {
      const options = recoveryOptions()
      writeFileSync(options.dataFile, '{{corrupt')
      for (let index = 0; index < 5; index++) {
        writeFileSync(`${options.dataFile}.bak.${index}`, `{{slot-${index}-corrupt`)
      }
      expect(() => createProfileStateStore(options)).toThrow(ProfileStateAuthorityBootstrapError)
      expect(existsSync(options.databaseFile)).toBe(false)
      expect(readFileSync(options.dataFile, 'utf8')).toBe('{{corrupt')
    })

    it('recovers repos and settings from a selected backup with a malformed session', () => {
      const options = recoveryOptions()
      writeFileSync(options.dataFile, '{{corrupt')
      writeFileSync(
        `${options.dataFile}.bak.0`,
        JSON.stringify({
          repos: [makeRepo({ id: 'survives' })],
          settings: { theme: 'dark' },
          workspaceSession: { activeRepoId: 12345 }
        })
      )
      const store = importRecoveredProfile(options)
      expect(store.getRepos().map((repo) => repo.id)).toEqual(['survives'])
      expect(store.getSettings().theme).toBe('dark')
    })
  })
})
