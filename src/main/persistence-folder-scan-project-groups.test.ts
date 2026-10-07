import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  closeTestStores,
  createStore,
  makeRepo,
  readPersistedStateJson,
  testState,
  writeDataFile
} from './persistence-test-harness'
import { getDefaultPersistedState } from '../shared/constants'
import { createProjectGroup } from '../shared/project-groups'
import { normalizeRuntimePathSeparators } from '../shared/cross-platform-path'
import { LoadedStateAdaptationOperations } from './persistence/loading-store/loaded-state-adaptation'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      return decoded.replace(/^encrypted:/, '')
    }
  }
}))

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(() => ({ hosts: [] })),
  sshConfigHostsToTargets: vi.fn(() => [])
}))

describe('Flat folder-scan project groups adaptation', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('leaves unchanged group membership and manual order clean on load', () => {
    const state = getDefaultPersistedState(testState.dir)
    const parentPath = join(testState.dir, 'projects')
    const group = createProjectGroup({
      name: 'Projects',
      parentPath,
      createdFrom: 'folder-scan',
      tabOrder: 0
    })
    state.projectGroups = [group]
    state.repos = ['alpha', 'beta'].map((name, index) =>
      makeRepo({
        id: name,
        path: join(parentPath, name),
        projectGroupId: group.id,
        projectGroupOrder: 1 - index
      })
    )
    const operations = new LoadedStateAdaptationOperations({ state, loadNeedsSave: false })

    expect(operations.adaptFlatFolderScanProjectGroups()).toBe(false)
    expect(state.projectGroups).toEqual([group])
    expect(state.repos.map((repo) => [repo.projectGroupId, repo.projectGroupOrder])).toEqual([
      [group.id, 1],
      [group.id, 0]
    ])
  })

  it.each([false, true])(
    'preserves saved order through a Store restart (folder repo: %s)',
    async (includeFolder) => {
      const store = createStore()
      const group = store.createProjectGroup({
        name: 'GitHub',
        parentPath: join(testState.dir, 'GitHub'),
        createdFrom: 'folder-scan'
      })
      store.addRepo(
        makeRepo({
          id: 'r1',
          path: join(testState.dir, 'GitHub', 'repo1'),
          projectGroupId: group.id,
          projectGroupOrder: 1
        })
      )
      store.addRepo(
        makeRepo({
          id: 'r2',
          path: join(testState.dir, 'GitHub', 'repo2'),
          projectGroupId: group.id,
          projectGroupOrder: 0
        })
      )
      if (includeFolder) {
        store.addRepo(
          makeRepo({
            id: 'folder',
            kind: 'folder',
            path: join(testState.dir, 'GitHub', 'notes'),
            projectGroupId: group.id,
            projectGroupOrder: 7
          })
        )
      }
      store.flush()
      const expectedRepos = [
        expect.objectContaining({ id: 'r1', projectGroupId: group.id, projectGroupOrder: 1 }),
        expect.objectContaining({ id: 'r2', projectGroupId: group.id, projectGroupOrder: 0 }),
        ...(includeFolder
          ? [
              expect.objectContaining({
                id: 'folder',
                kind: 'folder',
                projectGroupId: group.id,
                projectGroupOrder: 7
              })
            ]
          : [])
      ]
      expect(JSON.parse(readPersistedStateJson()).repos).toEqual(expectedRepos)
      await closeTestStores()

      const reloaded = createStore()
      expect(reloaded.getRepos()).toEqual(expectedRepos)
      expect(reloaded.getProjectGroups()).toEqual([group])
      reloaded.flush()
      expect(JSON.parse(readPersistedStateJson()).repos).toEqual(expectedRepos)
    }
  )

  it('re-indexes only repos migrating to a new child group', async () => {
    const parentPath = join(testState.dir, 'platform')
    writeDataFile({
      schemaVersion: 1,
      repos: [
        makeRepo({
          id: 'api',
          path: join(parentPath, 'api'),
          projectGroupId: 'root',
          projectGroupOrder: 10
        }),
        makeRepo({
          id: 'web',
          path: join(parentPath, 'web'),
          projectGroupId: 'root',
          projectGroupOrder: 20
        }),
        makeRepo({
          id: 'repo1',
          path: join(parentPath, 'packages', 'shared', 'repo1'),
          projectGroupId: 'root'
        }),
        makeRepo({
          id: 'repo2',
          path: join(parentPath, 'packages', 'shared', 'repo2'),
          projectGroupId: 'root'
        }),
        makeRepo({
          id: 'folder',
          kind: 'folder',
          path: join(parentPath, 'packages', 'shared', 'notes'),
          projectGroupId: 'root',
          projectGroupOrder: 30
        })
      ],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      projectGroups: [
        {
          id: 'root',
          name: 'Platform',
          parentPath,
          parentGroupId: null,
          createdFrom: 'folder-scan',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    const store = createStore()
    const groups = store.getProjectGroups()
    const shared = groups.find((group) => group.name === 'packages/shared')

    expect(groups.map((group) => [group.name, group.parentGroupId, group.parentPath])).toEqual([
      ['Platform', null, parentPath],
      [
        'packages/shared',
        'root',
        normalizeRuntimePathSeparators(join(parentPath, 'packages', 'shared'))
      ]
    ])
    expect(store.getRepo('api')?.projectGroupId).toBe('root')
    expect(store.getRepo('api')?.projectGroupOrder).toBe(10)
    expect(store.getRepo('web')?.projectGroupId).toBe('root')
    expect(store.getRepo('web')?.projectGroupOrder).toBe(20)
    expect(store.getRepo('repo1')?.projectGroupId).toBe(shared?.id)
    expect(store.getRepo('repo1')?.projectGroupOrder).toBe(0)
    expect(store.getRepo('repo2')?.projectGroupId).toBe(shared?.id)
    expect(store.getRepo('repo2')?.projectGroupOrder).toBe(1)
    expect(store.getRepo('folder')).toEqual(
      expect.objectContaining({
        kind: 'folder',
        projectGroupId: 'root',
        projectGroupOrder: 30
      })
    )
    store.flush()
    await closeTestStores()
    const reloaded = createStore()
    expect(reloaded.getProjectGroups()).toEqual(groups)
    expect(reloaded.getRepos()).toEqual(store.getRepos())
  })
})
