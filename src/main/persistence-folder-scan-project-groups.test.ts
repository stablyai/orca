import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  closeTestStores,
  createStore,
  makeRepo,
  testState,
  writeDataFile
} from './persistence-test-harness'

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

  it('preserves projectGroupOrder across reloads for flat folder-scan project groups', async () => {
    const store = await createStore()
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
        projectGroupOrder: 5
      })
    )
    store.addRepo(
      makeRepo({
        id: 'r2',
        path: join(testState.dir, 'GitHub', 'repo2'),
        projectGroupId: group.id,
        projectGroupOrder: 2
      })
    )
    store.flush()

    const reloaded = await createStore()
    expect(reloaded.getRepo('r1')?.projectGroupOrder).toBe(5)
    expect(reloaded.getRepo('r2')?.projectGroupOrder).toBe(2)
  })

  it('re-indexes only repos migrating to a new child group', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [
        makeRepo({
          id: 'api',
          path: '/workspace/platform/api',
          projectGroupId: 'root',
          projectGroupOrder: 10
        }),
        makeRepo({
          id: 'web',
          path: '/workspace/platform/web',
          projectGroupId: 'root',
          projectGroupOrder: 20
        }),
        makeRepo({
          id: 'repo1',
          path: '/workspace/platform/packages/shared/repo1',
          projectGroupId: 'root'
        }),
        makeRepo({
          id: 'repo2',
          path: '/workspace/platform/packages/shared/repo2',
          projectGroupId: 'root'
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
          parentPath: '/workspace/platform',
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

    const store = await createStore()
    const groups = store.getProjectGroups()
    const shared = groups.find((group) => group.name === 'packages/shared')

    expect(groups.map((group) => [group.name, group.parentGroupId, group.parentPath])).toEqual([
      ['Platform', null, '/workspace/platform'],
      ['packages/shared', 'root', '/workspace/platform/packages/shared']
    ])
    expect(store.getRepo('api')?.projectGroupId).toBe('root')
    expect(store.getRepo('api')?.projectGroupOrder).toBe(10)
    expect(store.getRepo('web')?.projectGroupId).toBe('root')
    expect(store.getRepo('web')?.projectGroupOrder).toBe(20)
    expect(store.getRepo('repo1')?.projectGroupId).toBe(shared?.id)
    expect(store.getRepo('repo1')?.projectGroupOrder).toBe(0)
    expect(store.getRepo('repo2')?.projectGroupId).toBe(shared?.id)
    expect(store.getRepo('repo2')?.projectGroupOrder).toBe(1)
  })
})
