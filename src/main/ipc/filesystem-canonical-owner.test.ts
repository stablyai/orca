import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/repo-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import { getAllowedRoots, getLocalRepos } from './filesystem-allowed-roots'
import { isPathAllowed } from './filesystem-auth'
import {
  __resetCreatedWorktreeRootsForTests,
  invalidateAuthorizedRootsCache,
  isRegisteredWorktreePath,
  rebuildAuthorizedRootsCache,
  registerCreatedWorktreeRoot,
  registerWorktreeRootsForRepo
} from './registered-worktree-roots-cache'

const mocks = vi.hoisted(() => ({ graph: vi.fn(), stat: vi.fn(), realpath: vi.fn() }))
vi.mock('node:fs/promises', () => ({ stat: mocks.stat, realpath: mocks.realpath }))
vi.mock('../repo-worktrees', () => ({ listRepoWorktreeGraph: mocks.graph, isRepoRoot: vi.fn() }))
vi.mock('./worktree-logic', () => ({
  computeWorkspaceRoot: vi.fn(),
  getWorktreePathSettings: vi.fn()
}))
vi.mock('../project-runtime-git-options', () => ({
  getWorktreeMirrorDistroForRuntime: vi.fn(),
  resolveLocalProjectRuntimesForRepos: vi.fn()
}))

type Owner = Pick<Repo, 'connectionId' | 'executionHostId'>
const root = resolve('/owner-fixture')
const linked = resolve('/linked-fixture')
function repo(owner: Owner = {}, overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo',
    path: root,
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    ...owner,
    ...overrides
  }
}
function group(owner: Owner = {}, overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group',
    name: 'group',
    parentPath: root,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0,
    ...owner,
    ...overrides
  }
}
function folder(owner: Owner = {}): FolderWorkspace {
  return {
    id: 'folder',
    projectGroupId: 'group',
    name: 'folder',
    folderPath: root,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...owner
  }
}
function storeFor(
  repos: Repo[] = [],
  groups: ProjectGroup[] = [],
  folders: FolderWorkspace[] = []
): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Authorization reads only these catalog and settings methods; every fixture omits workspaceDir.
  return {
    getRepos: () => repos,
    getProjectGroups: () => groups,
    getFolderWorkspaces: () => folders,
    getSettings: () => ({})
  } as Store
}

const deniedOwners: { name: string; owner: Owner }[] = [
  { name: 'canonical SSH', owner: { executionHostId: 'ssh:host-a' } },
  { name: 'encoded canonical SSH', owner: { executionHostId: 'ssh:host%20a' } },
  { name: 'legacy SSH', owner: { connectionId: 'host-a' } },
  {
    name: 'explicit local with legacy SSH',
    owner: { executionHostId: 'local', connectionId: 'host-a' }
  },
  {
    name: 'runtime with legacy SSH',
    owner: { executionHostId: 'runtime:env', connectionId: 'host-a' }
  }
]
const allowedOwners: { name: string; owner: Owner }[] = [
  { name: 'unscoped local', owner: {} },
  { name: 'explicit local', owner: { executionHostId: 'local' } },
  { name: 'own-store runtime', owner: { executionHostId: 'runtime:env' } }
]

it('denies every SSH-owned direct and folder-scope path in the fixture matrix', () => {
  const stores = deniedOwners.flatMap(({ owner }) => [
    storeFor([repo(owner)]),
    storeFor([], [group(owner)]),
    storeFor([], [], [folder(owner)]),
    storeFor([], [group(owner)], [folder()]),
    storeFor([repo(owner, { path: join(root, 'child') })], [group()], [folder()])
  ])
  const denied = stores.filter((store) => !isPathAllowed(join(root, 'file'), store)).length
  console.log(JSON.stringify({ fixturePaths: stores.length, denied }))
  expect(denied).toBe(stores.length)
})

beforeEach(() => {
  invalidateAuthorizedRootsCache()
  __resetCreatedWorktreeRootsForTests()
  vi.clearAllMocks()
  mocks.graph.mockResolvedValue([])
  mocks.stat.mockResolvedValue({})
  mocks.realpath.mockImplementation(async (path: string) => path)
})

describe.each(deniedOwners)('$name filesystem ownership', ({ owner }) => {
  it('does not grant a repository root or register linked roots', async () => {
    const store = storeFor([repo(owner)])
    expect(getLocalRepos(store)).toEqual([])
    expect(isPathAllowed(join(root, 'file'), store)).toBe(false)
    registerWorktreeRootsForRepo(store, 'repo', [linked])
    registerCreatedWorktreeRoot(store, 'repo', linked)
    expect(isRegisteredWorktreePath(linked)).toBe(false)
    await rebuildAuthorizedRootsCache(store)
    expect(isRegisteredWorktreePath(root)).toBe(false)
    expect(mocks.graph).not.toHaveBeenCalled()
    expect(mocks.stat).not.toHaveBeenCalled()
  })

  it.each(['group', 'folder', 'inherited group'] as const)(
    'does not grant an empty %s scope',
    (kind) => {
      const store = storeFor(
        [],
        kind !== 'folder' ? [group(owner)] : [],
        kind === 'folder' ? [folder(owner)] : kind === 'inherited group' ? [folder()] : []
      )
      expect(getAllowedRoots(store)).toEqual([])
      expect(isPathAllowed(join(root, 'file'), store)).toBe(false)
    }
  )

  it('does not infer a local group or folder from a remote child repo', () => {
    const store = storeFor(
      [repo(owner, { path: join(root, 'child'), projectGroupId: 'nested' })],
      [group(), group({}, { id: 'nested', parentGroupId: 'group', parentPath: null })],
      [folder()]
    )
    expect(getAllowedRoots(store)).toEqual([])
    expect(isPathAllowed(join(root, 'file'), store)).toBe(false)
  })
})

describe.each(allowedOwners)('$name filesystem ownership', ({ owner }) => {
  it('preserves repo, group, folder and recovered worktree roots', () => {
    for (const store of [
      storeFor([repo(owner)]),
      storeFor([], [group(owner)]),
      storeFor([], [], [folder(owner)])
    ]) {
      expect(getAllowedRoots(store)).toEqual([root])
      expect(isPathAllowed(join(root, 'file'), store)).toBe(true)
    }
    const store = storeFor([repo(owner)])
    registerWorktreeRootsForRepo(store, 'repo', [root])
    registerCreatedWorktreeRoot(store, 'repo', linked)
    invalidateAuthorizedRootsCache()
    expect(isRegisteredWorktreePath(linked)).toBe(true)
    expect(mocks.graph).not.toHaveBeenCalled()
    expect(mocks.stat).not.toHaveBeenCalled()
  })
})

it('preserves an unpinned mixed local and SSH folder scope', () => {
  const store = storeFor(
    [
      repo({ executionHostId: 'ssh:host-a' }, { path: join(root, 'remote') }),
      repo({}, { id: 'local', path: join(root, 'local') })
    ],
    [group()],
    [folder()]
  )
  expect(getAllowedRoots(store)).toEqual([join(root, 'local'), root, root])
})

it('keeps an explicit SSH folder scope remote even with a local candidate', () => {
  const store = storeFor(
    [repo({}, { path: join(root, 'local') })],
    [group({ executionHostId: 'ssh:host-a' })],
    [folder()]
  )
  expect(getAllowedRoots(store)).toEqual([join(root, 'local')])
  expect(isPathAllowed(join(root, 'file'), store)).toBe(false)
})

it('preserves explicit local folder overrides and the legacy empty connection override', () => {
  expect(
    getAllowedRoots(
      storeFor(
        [],
        [group({ executionHostId: 'ssh:host-a' })],
        [folder({ executionHostId: 'local' })]
      )
    )
  ).toEqual([root])
  expect(
    getAllowedRoots(
      storeFor([], [group({ connectionId: 'host-a' })], [folder({ connectionId: '' })])
    )
  ).toEqual([root])
})
