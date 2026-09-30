import {
  closeTestStores,
  readPersistedStateJson,
  testState,
  createStore,
  dataFile,
  writeDataFile,
  readDataFile,
  makeRepo,
  makeWorktreeLineage,
  makeWorkspaceLineage
} from './persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, readFileSync, rmSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProfileStateStore } from './persistence/profile-state/profile-state-store-factory'
import { ProfileStateAuthorityBootstrapError } from './persistence/profile-state/profile-state-authority-bootstrap'
import { restoreProfileStateJsonExport } from './persistence/profile-state/legacy-json/profile-state-recovery'
import { acquireProfileStateMaintenance } from './persistence/profile-state/profile-state-access'
import type { Repo } from '../shared/repo-types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../shared/workspace-scope'

// Stub the ~/.ssh/config parser so the SSH-import test drives the real Store with deterministic hosts, not the operator's actual ~/.ssh/config.
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

vi.mock('./telemetry/client', () => ({
  track: trackMock
}))

vi.mock('./telemetry/cohort-classifier', () => ({
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
  // ── getAllWorktreeMeta ─────────────────────────────────────────────

  it('getAllWorktreeMeta returns all entries', async () => {
    const store = await createStore()
    store.setWorktreeMeta('a', { displayName: 'A' })
    store.setWorktreeMeta('b', { displayName: 'B' })
    const all = store.getAllWorktreeMeta()
    expect(Object.keys(all)).toHaveLength(2)
    expect(all['a'].displayName).toBe('A')
    expect(all['b'].displayName).toBe('B')
  })

  // ── removeWorktreeMeta ─────────────────────────────────────────────

  it('removeWorktreeMeta deletes a single entry', async () => {
    const store = await createStore()
    store.setWorktreeMeta('a', { displayName: 'A' })
    store.setWorktreeMeta('b', { displayName: 'B' })
    store.removeWorktreeMeta('a')
    expect(store.getWorktreeMeta('a')).toBeUndefined()
    expect(store.getWorktreeMeta('b')).toBeDefined()
  })

  it('stores and removes worktree lineage independently from metadata', async () => {
    const store = await createStore()
    const lineage = makeWorktreeLineage()

    store.setWorktreeMeta(lineage.worktreeId, { displayName: 'child' })
    store.setWorktreeLineage(lineage.worktreeId, lineage)

    expect(store.getWorktreeLineage(lineage.worktreeId)).toEqual(lineage)
    expect(store.getAllWorktreeLineage()).toEqual({ [lineage.worktreeId]: lineage })

    store.removeWorktreeLineage(lineage.worktreeId)

    expect(store.getWorktreeLineage(lineage.worktreeId)).toBeUndefined()
    expect(store.getWorktreeMeta(lineage.worktreeId)).toBeDefined()
  })

  it('removeWorktreeMeta deletes that worktree lineage entry', async () => {
    const store = await createStore()
    const lineage = makeWorktreeLineage()

    store.setWorktreeMeta(lineage.worktreeId, { displayName: 'child' })
    store.setWorktreeLineage(lineage.worktreeId, lineage)

    store.removeWorktreeMeta(lineage.worktreeId)

    expect(store.getWorktreeMeta(lineage.worktreeId)).toBeUndefined()
    expect(store.getWorktreeLineage(lineage.worktreeId)).toBeUndefined()
  })

  it('stores workspace lineage and removes it with the child worktree metadata', async () => {
    const store = await createStore()
    const lineage = makeWorkspaceLineage()

    store.setWorktreeMeta('r1::/path/child', { displayName: 'child' })
    store.setWorkspaceLineage(lineage)

    expect(store.getWorkspaceLineage(lineage.childWorkspaceKey)).toEqual(lineage)
    expect(store.getAllWorkspaceLineage()).toEqual({ [lineage.childWorkspaceKey]: lineage })

    store.removeWorktreeMeta('r1::/path/child')

    expect(store.getWorkspaceLineage(lineage.childWorkspaceKey)).toBeUndefined()
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

  // ── Live Claude PTY session ids (STA-1246) ─────────────────────────

  describe('mobileClientTabSelectionsByDeviceId', () => {
    it('persists device tab selections across reloads and drops malformed payloads', async () => {
      const store = await createStore()
      // Registered on purpose: rows owned by an unregistered repo id are swept as orphans on load.
      store.addRepo(makeRepo({ id: 'repo-1', path: '/repo-1' }))
      store.setMobileClientTabSelections({
        'device-a': {
          'repo-1::/tmp/wt': { activeTabId: 'tab-1', activeGroupId: 'g1', activeTabIdByGroupId: {} }
        }
      })
      store.flush()

      const reloaded = await createStore()
      expect(reloaded.getMobileClientTabSelections()['device-a']?.['repo-1::/tmp/wt']).toEqual({
        activeTabId: 'tab-1',
        activeGroupId: 'g1',
        activeTabIdByGroupId: {}
      })

      writeDataFile({ mobileClientTabSelectionsByDeviceId: { 'device-a': 'corrupt' } })
      const corrupted = await createStore()
      expect(corrupted.getMobileClientTabSelections()).toEqual({})
    })

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

      store.removeProject('r1')
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

  describe('claudeLivePtySessionIds', () => {
    it('persists added ids across reloads and removes them durably', async () => {
      const store = await createStore()

      store.addClaudeLivePtySessionId('claude-session-1')
      store.addClaudeLivePtySessionId('claude-session-2')
      store.addClaudeLivePtySessionId('claude-session-1')

      expect(store.getClaudeLivePtySessionIds()).toEqual(['claude-session-1', 'claude-session-2'])

      const reloaded = await createStore()
      expect(reloaded.getClaudeLivePtySessionIds()).toEqual([
        'claude-session-1',
        'claude-session-2'
      ])

      reloaded.removeClaudeLivePtySessionId('claude-session-1')
      reloaded.flush()

      const reloadedAgain = await createStore()
      expect(reloadedAgain.getClaudeLivePtySessionIds()).toEqual(['claude-session-2'])
    })

    it('drops malformed persisted entries on load', async () => {
      writeDataFile({
        schemaVersion: 1,
        claudeLivePtySessionIds: ['valid-id', '', 42, null, 'valid-id', 'x'.repeat(513)]
      })

      const store = await createStore()

      expect(store.getClaudeLivePtySessionIds()).toEqual(['valid-id'])
    })

    it('keeps the newest ids when an oversized persisted list is loaded', async () => {
      writeDataFile({
        schemaVersion: 1,
        claudeLivePtySessionIds: Array.from({ length: 205 }, (_, index) => `claude-${index}`)
      })

      const store = await createStore()

      const ids = store.getClaudeLivePtySessionIds()
      expect(ids).toHaveLength(200)
      expect(ids[0]).toBe('claude-5')
      expect(ids[199]).toBe('claude-204')
    })

    it('caps the persisted id list', async () => {
      const store = await createStore()
      for (let index = 0; index < 205; index += 1) {
        store.addClaudeLivePtySessionId(`claude-session-${index}`)
      }

      const ids = store.getClaudeLivePtySessionIds()
      expect(ids).toHaveLength(200)
      expect(ids[0]).toBe('claude-session-5')
      expect(ids[199]).toBe('claude-session-204')
    })
  })

  describe('retired JSON backups', () => {
    it.each(['sync', 'async'] as const)(
      'leaves legacy JSON and backups unchanged during %s SQL writes',
      async (flush) => {
        writeDataFile({ repos: [makeRepo({ id: 'seed' })] })
        const retained = readFileSync(dataFile())
        const backup = `${dataFile()}.bak.0`
        writeFileSync(backup, retained)
        const store = createStore()
        store.addRepo(makeRepo({ id: 'updated', path: '/updated' }))
        if (flush === 'sync') {
          store.flushOrThrow()
        } else {
          await store.flushPendingOrThrowAsync()
        }

        expect(readFileSync(dataFile())).toEqual(retained)
        expect(readFileSync(backup)).toEqual(retained)
        expect(existsSync(`${dataFile()}.bak.1`)).toBe(false)
        const persisted = readDataFile() as { repos: Repo[] }
        expect(persisted.repos.map((repo) => repo.id).sort()).toEqual(['seed', 'updated'])
      }
    )

    it('does not create a JSON primary or backup for a fresh SQL profile', () => {
      const store = createStore()
      store.addRepo(makeRepo())
      store.flushOrThrow()
      expect(existsSync(dataFile())).toBe(false)
      expect(existsSync(`${dataFile()}.bak.0`)).toBe(false)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture registered r1 before flushing; its exported repos are Repo records.
      expect((readDataFile() as { repos: Repo[] }).repos.map((repo) => repo.id)).toEqual(['r1'])
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

  // ── Concurrent write serialization (issue #1158) ───────────────────

  describe('concurrent write serialization', () => {
    it('chains debounced writes via pendingWrite so they run sequentially', async () => {
      vi.useFakeTimers()
      try {
        const store = await createStore()
        store.addRepo(makeRepo({ id: 'first' }))
        vi.advanceTimersByTime(1000)
        store.addRepo(makeRepo({ id: 'second', path: '/second' }))
        vi.advanceTimersByTime(1000)
        await store.waitForPendingWrite()

        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The preceding Store save produced the PersistedState snapshot read by this test.
        const persisted = JSON.parse(readPersistedStateJson()) as { repos: Repo[] }
        expect(persisted.repos.map((r) => r.id).sort()).toEqual(['first', 'second'])
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
