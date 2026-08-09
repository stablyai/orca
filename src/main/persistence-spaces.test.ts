import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { FolderWorkspace, Repo, Space } from '../shared/types'
import { getDefaultPersistedState } from '../shared/constants'
import { DEFAULT_SPACE_ID } from '../shared/spaces'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

async function createStoreFromState(state: Record<string, unknown>) {
  mkdirSync(testState.dir, { recursive: true })
  const persisted: Record<string, unknown> = {
    ...getDefaultPersistedState(testState.dir),
    ...state
  }
  if (!('spaces' in state)) {
    delete persisted.spaces
  }
  writeFileSync(join(testState.dir, 'orca-data.json'), JSON.stringify(persisted), 'utf-8')
  vi.resetModules()
  const { Store, initDataPath } = await import('./persistence')
  initDataPath()
  return new Store()
}

function repo(id: string, spaceId?: string | null): Repo {
  return {
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 1,
    executionHostId: 'local',
    ...(spaceId === undefined ? {} : { spaceId })
  } as Repo
}

function customSpace(id: string, createdAt = 1): Space {
  return { id, name: id, emoji: '🚀', createdAt, updatedAt: createdAt }
}

function folderWorkspace(id: string): FolderWorkspace {
  return {
    id,
    projectGroupId: 'group-1',
    name: id,
    folderPath: `/folders/${id}`,
    connectionId: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    createdAt: 1,
    updatedAt: 1
  } as FolderWorkspace
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-spaces-'))
})

afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('Space persistence', () => {
  it('loads pre-Spaces state into Default without changing repo membership', async () => {
    const store = await createStoreFromState({ repos: [repo('a')] })

    expect(store.getSpaces().map((space) => space.id)).toEqual([DEFAULT_SPACE_ID])
    expect(store.getUI().activeSpaceId).toBe(DEFAULT_SPACE_ID)
    expect(store.getRepos()[0]?.spaceId).toBeUndefined()
  })

  it('repairs malformed catalogs, stale memberships, and stale UI state', async () => {
    const store = await createStoreFromState({
      spaces: [customSpace('space-b', 2), null, { name: 'no id' }, customSpace('space-a', 1)],
      repos: [repo('stale', 'space-gone'), repo('valid', 'space-a')],
      ui: {
        activeSpaceId: 'space-gone',
        lastWorkspaceKeyBySpaceId: {
          'space-gone': 'worktree:gone',
          'space-a': 'folder:folder-1'
        }
      }
    })

    expect(store.getSpaces().map((space) => space.id)).toEqual([
      DEFAULT_SPACE_ID,
      'space-a',
      'space-b'
    ])
    expect(store.getRepos().map((entry) => entry.spaceId)).toEqual([undefined, 'space-a'])
    expect(store.getUI()).toMatchObject({
      activeSpaceId: DEFAULT_SPACE_ID,
      lastWorkspaceKeyBySpaceId: { 'space-a': 'folder:folder-1' }
    })
  })

  it('creates and updates normalized Spaces while protecting Default from deletion', async () => {
    const store = await createStoreFromState({})
    const created = store.createSpace({ name: '  Work  ', emoji: '🧪🧨' })

    expect(created).toMatchObject({ name: 'Work', emoji: '🧪' })
    expect(store.updateSpace(DEFAULT_SPACE_ID, { name: 'Personal' })?.name).toBe('Personal')
    expect(store.deleteSpace(DEFAULT_SPACE_ID)).toBe(false)
    expect(store.deleteSpace('space-gone')).toBe(false)
  })

  it('deleting a Space reassigns projects and UI state without deleting workspaces', async () => {
    const store = await createStoreFromState({
      spaces: [customSpace('space-a')],
      repos: [repo('a', 'space-a'), repo('b')],
      projectGroups: [
        {
          id: 'group-1',
          name: 'Group',
          parentPath: '/folders',
          parentGroupId: null,
          createdFrom: 'manual',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      folderWorkspaces: [folderWorkspace('folder-1')],
      worktreeMeta: { 'wt-1': { repoId: 'a', comment: 'keep me' } },
      ui: { activeSpaceId: 'space-a', lastWorkspaceKeyBySpaceId: { 'space-a': 'worktree:wt-1' } }
    })

    expect(store.deleteSpace('space-a')).toBe(true)
    expect(store.getRepos().map((entry) => entry.spaceId ?? null)).toEqual([null, null])
    expect(store.getFolderWorkspaces()).toHaveLength(1)
    expect(store.getAllWorktreeMeta()['wt-1']?.comment).toBe('keep me')
    expect(store.getUI()).toMatchObject({
      activeSpaceId: DEFAULT_SPACE_ID,
      lastWorkspaceKeyBySpaceId: {}
    })
  })

  it('moves only the selected host and normalizes invalid targets to Default', async () => {
    const store = await createStoreFromState({
      spaces: [customSpace('space-a')],
      repos: [
        repo('shared'),
        { ...repo('shared'), path: '/remote/shared', executionHostId: 'ssh:server' }
      ]
    })

    expect(store.moveProjectToSpace('shared', 'space-a', 'ssh:server')?.spaceId).toBe('space-a')
    expect(store.getRepos().map((entry) => entry.spaceId ?? null)).toEqual([null, 'space-a'])
    expect(store.moveProjectToSpace('shared', 'space-gone', 'ssh:server')?.spaceId).toBeUndefined()
    expect(store.moveProjectToSpace('missing', 'space-a', 'local')).toBeNull()
  })

  it('inherits active membership unless explicitly assigned or bypassed by a remote caller', async () => {
    const store = await createStoreFromState({ spaces: [customSpace('space-a')] })
    store.updateUI({ activeSpaceId: 'space-a' })

    store.addRepo(repo('active'))
    store.addRepo(repo('explicit', 'space-a'))
    store.addRepo(repo('invalid', 'space-gone'))
    store.addRepo(repo('remote'), null)

    expect(store.getRepos().map((entry) => [entry.id, entry.spaceId])).toEqual([
      ['active', 'space-a'],
      ['explicit', 'space-a'],
      ['invalid', undefined],
      ['remote', undefined]
    ])
  })
})
