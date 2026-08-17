import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultWorkspaceSession } from '../shared/constants'
import type { ProjectGroup } from '../shared/project-group-types'
import { folderWorkspaceKey } from '../shared/workspace-scope'
import {
  createStore,
  makeRepo,
  makeTerminalTab,
  testState,
  writeDataFile
} from './persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

function makeGroup(
  id: string,
  name: string,
  connectionId: string | null,
  parentGroupId: string | null = null
): ProjectGroup {
  return {
    id,
    name,
    parentPath: connectionId ? `/remote/${id}` : `/local/${id}`,
    connectionId,
    parentGroupId,
    createdFrom: 'folder-scan',
    tabOrder: parentGroupId ? 1 : 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function writeOwnerState(overrides: Record<string, unknown>): void {
  writeDataFile({
    schemaVersion: 1,
    repos: [],
    worktreeMeta: {},
    settings: {},
    ui: {},
    githubCache: { pr: {}, issue: {} },
    ...overrides
  })
}

describe('project group persistence owner identity', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-owner-identity-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('moves duplicate repo ids only within the selected owner', async () => {
    writeOwnerState({
      repos: [
        makeRepo({ id: 'same-repo', path: '/local', projectGroupOrder: 900 }),
        makeRepo({
          id: 'same-repo',
          path: '/ssh',
          connectionId: 'builder',
          projectGroupOrder: 1
        }),
        makeRepo({
          id: 'ssh-sibling',
          path: '/ssh/sibling',
          connectionId: 'builder',
          projectGroupId: 'same-group',
          projectGroupOrder: 5
        })
      ],
      projectGroups: [
        makeGroup('same-group', 'Local', null),
        makeGroup('same-group', 'SSH', 'builder'),
        makeGroup('local-only', 'Local only', null)
      ]
    })
    const store = await createStore()

    expect(store.moveProjectToGroup('same-repo', null)).toBeNull()
    expect(store.moveProjectToGroup('same-repo', null, undefined, 'ssh:missing')).toBeNull()
    expect(store.moveProjectToGroup('same-repo', 'local-only', undefined, 'ssh:builder')).toBeNull()
    expect(
      store.moveProjectToGroup('same-repo', 'same-group', undefined, 'ssh:builder')
    ).toMatchObject({ path: '/ssh', projectGroupId: 'same-group', projectGroupOrder: 6 })
    expect(store.getRepos().find((repo) => repo.path === '/local')).toMatchObject({
      projectGroupOrder: 900
    })
  })

  it('updates and deletes same-id group subtrees only within the selected owner', async () => {
    const groups = [
      makeGroup('root', 'Local root', null),
      makeGroup('child', 'Local child', null, 'root'),
      makeGroup('root', 'SSH root', 'builder'),
      makeGroup('child', 'SSH child', 'builder', 'root')
    ]
    writeOwnerState({
      repos: [
        makeRepo({ id: 'local-repo', path: '/local/repo', projectGroupId: 'child' }),
        makeRepo({
          id: 'ssh-repo',
          path: '/remote/repo',
          projectGroupId: 'child',
          connectionId: 'builder'
        })
      ],
      projectGroups: groups
    })
    const store = await createStore()
    const localFolder = store.createFolderWorkspace({
      projectGroupId: 'child',
      connectionId: null
    })
    const sshFolder = store.createFolderWorkspace({
      projectGroupId: 'child',
      connectionId: 'builder'
    })

    expect(store.updateProjectGroup('root', { name: 'Ambiguous' })).toBeNull()
    expect(store.updateProjectGroup('root', { name: 'Remote' }, 'ssh:builder')?.name).toBe('Remote')
    expect(store.deleteProjectGroup('root', 'local')).toBe(true)
    expect(store.getProjectGroups().map((group) => [group.name, group.connectionId])).toEqual([
      ['Remote', 'builder'],
      ['SSH child', 'builder']
    ])
    expect(store.getRepo('local-repo')?.projectGroupId).toBeNull()
    expect(store.getRepo('ssh-repo')?.projectGroupId).toBe('child')
    expect(store.getFolderWorkspace(localFolder.id)).toBeUndefined()
    expect(store.getFolderWorkspace(sshFolder.id)).toBeDefined()
  })

  it('resolves same-id folder creation from explicit connection ownership', async () => {
    writeOwnerState({
      projectGroups: [makeGroup('same-id', 'Local', null), makeGroup('same-id', 'SSH', 'builder')]
    })
    const store = await createStore()

    expect(
      store.createFolderWorkspace({ projectGroupId: 'same-id', connectionId: null }).folderPath
    ).toBe('/local/same-id')
    expect(
      store.createFolderWorkspace({ projectGroupId: 'same-id', connectionId: 'builder' }).folderPath
    ).toBe('/remote/same-id')
    expect(() => store.createFolderWorkspace({ projectGroupId: 'same-id' })).toThrow(
      'Folder-backed project group not found.'
    )
  })

  it('updates and removes duplicate folder ids only within the selected owner', async () => {
    const folder = {
      id: 'same-folder',
      projectGroupId: 'same-id',
      name: 'Folder',
      folderPath: '/folder',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 1,
      lastActivityAt: 1,
      createdAt: 1,
      updatedAt: 1
    }
    writeOwnerState({
      projectGroups: [makeGroup('same-id', 'Local', null), makeGroup('same-id', 'SSH', 'builder')],
      folderWorkspaces: [
        { ...folder, name: 'Local', folderPath: '/local/folder', connectionId: null },
        { ...folder, name: 'SSH', folderPath: '/remote/folder', connectionId: 'builder' }
      ]
    })
    const store = await createStore()
    const localKey = folderWorkspaceKey('same-folder', 'local')
    const sshKey = folderWorkspaceKey('same-folder', 'ssh:builder')
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [localKey]: [makeTerminalTab({ id: 'local-tab', worktreeId: localKey })],
        [sshKey]: [makeTerminalTab({ id: 'ssh-tab', worktreeId: sshKey })]
      }
    })

    expect(store.getFolderWorkspace('same-folder')).toBeUndefined()
    expect(store.updateFolderWorkspace('same-folder', { name: 'Ambiguous' })).toBeNull()
    expect(
      store.updateFolderWorkspace('same-folder', { name: 'Remote' }, 'ssh:builder')?.name
    ).toBe('Remote')
    expect(store.removeFolderWorkspace('same-folder')).toBe(false)
    expect(store.removeFolderWorkspace('same-folder', 'local')).toBe(true)
    expect(store.getFolderWorkspace('same-folder', 'ssh:builder')?.name).toBe('Remote')
    expect(store.getWorkspaceSession().tabsByWorktree[localKey]).toBeUndefined()
    expect(store.getWorkspaceSession().tabsByWorktree[sshKey]).toHaveLength(1)
  })
})
