import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../../persistence/loading-store/store'
import type { Repo } from '../../../shared/repo-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import { resolveFolderWorkspaceHost } from '../../../shared/folder-workspaces/folder-workspace-execution-host'
import { getAllowedRoots, getLocalRepos } from './access/filesystem-allowed-roots'
import { isPathAllowed } from './access/filesystem-auth'
import {
  __resetCreatedWorktreeRootsForTests,
  invalidateAuthorizedRootsCache,
  isRegisteredWorktreePath,
  rebuildAuthorizedRootsCache,
  registerCreatedWorktreeRoot,
  registerWorktreeRootsForRepo
} from '../worktrees/removal/registered-worktree-roots-cache'

const mocks = vi.hoisted(() => ({
  graph: vi.fn(),
  stat: vi.fn(),
  realpath: vi.fn(),
  workspaceRoot: vi.fn(),
  pathSettings: vi.fn(),
  projectRuntimes: vi.fn()
}))
vi.mock('node:fs/promises', () => ({ stat: mocks.stat, realpath: mocks.realpath }))
vi.mock('../../workspaces/catalog/repo-worktrees', () => ({
  listRepoWorktreeGraph: mocks.graph,
  isRepoRoot: vi.fn()
}))
vi.mock('../worktree-logic', () => ({
  computeWorkspaceRootWithin: async (...args: unknown[]) => mocks.workspaceRoot(...args),
  getWorktreePathSettings: mocks.pathSettings
}))
vi.mock('../../workspaces/execution-host/project-runtime-git-options', () => ({
  getWorktreeMirrorDistroForRuntime: vi.fn()
}))
vi.mock('../../workspaces/execution-host/local-project-runtime-resolution', () => ({
  resolveLocalProjectRuntimesForRepos: mocks.projectRuntimes
}))

/** Widen owner stamps to exercise older catalogs, malformed input and partial migrations beyond the typed union. */
type Owner = { connectionId?: string | null; executionHostId?: string | null }
const root = resolve('/owner-fixture')
const linked = resolve('/linked-fixture')
function repo(owner: Owner = {}, overrides: Partial<Repo> = {}): Repo {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only `executionHostId` leaves the union, and only to the malformed stamps above; every other field is a checked `Repo` field.
  return {
    id: 'repo',
    path: root,
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    ...owner,
    ...overrides
  } as Repo
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same widened stamp as `repo`; all other fields are checked `FolderWorkspace` fields.
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
  } as FolderWorkspace
}
function storeFor(
  repos: Repo[] = [],
  groups: ProjectGroup[] = [],
  folders: FolderWorkspace[] = [],
  settings: { workspaceDir?: string } = {}
): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Authorization reads only these catalog and settings methods; fixtures omit workspaceDir unless the case is about it.
  return {
    getRepos: () => repos,
    getProjectGroups: () => groups,
    getFolderWorkspaces: () => folders,
    getSettings: () => settings
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
  },
  // Rejected host IDs must fail closed; null SSH extraction alone does not prove local ownership.
  { name: 'empty SSH target', owner: { executionHostId: 'ssh:' } },
  { name: 'undecodable SSH target', owner: { executionHostId: 'ssh:%zz' } },
  { name: 'alias-delimiter SSH target', owner: { executionHostId: 'ssh:host-a|alias' } },
  { name: 'wrong-case SSH prefix', owner: { executionHostId: 'SSH:host-a' } },
  { name: 'unknown host kind', owner: { executionHostId: 'relay:host-a' } }
]

beforeEach(() => {
  invalidateAuthorizedRootsCache()
  __resetCreatedWorktreeRootsForTests()
  vi.clearAllMocks()
  mocks.graph.mockResolvedValue([])
  mocks.stat.mockResolvedValue({})
  mocks.realpath.mockImplementation(async (path: string) => path)
  mocks.projectRuntimes.mockReturnValue(new Map())
  mocks.pathSettings.mockImplementation(
    (_repo: Repo, settings: { workspaceDir: string }) => settings
  )
  mocks.workspaceRoot.mockImplementation(
    (_repoPath: string, settings: { workspaceDir: string }) => settings.workspaceDir
  )
})

describe.each(deniedOwners)('$name filesystem ownership', ({ owner }) => {
  it('does not grant a repository root or register linked roots', async () => {
    const store = storeFor([repo(owner)])
    expect(getLocalRepos(store)).toEqual([])
    expect(await isPathAllowed(join(root, 'file'), store)).toBe(false)
    registerWorktreeRootsForRepo(store, 'repo', [linked])
    registerCreatedWorktreeRoot(store, 'repo', linked)
    expect(isRegisteredWorktreePath(linked, store)).toBe(false)
    await rebuildAuthorizedRootsCache(store)
    expect(isRegisteredWorktreePath(root, store)).toBe(false)
    expect(mocks.graph).not.toHaveBeenCalled()
    expect(mocks.stat).not.toHaveBeenCalled()
  })
})

it('keeps an explicit SSH folder scope remote even with a local candidate', async () => {
  const store = storeFor(
    [repo({}, { path: join(root, 'local') })],
    [group({ executionHostId: 'ssh:host-a' })],
    [folder()]
  )
  expect(await getAllowedRoots(store)).toEqual([join(root, 'local')])
  expect(await isPathAllowed(join(root, 'file'), store)).toBe(false)
})

it('denies a workspace pinned local under a group carrying only a legacy connection', async () => {
  const pinnedFolder = folder({ executionHostId: 'local' })
  const legacyGroup = group({ connectionId: 'host-a' })
  const store = storeFor([], [legacyGroup], [pinnedFolder])
  expect(await getAllowedRoots(store)).toEqual([])
  expect(await isPathAllowed(join(root, 'file'), store)).toBe(false)
  // Dispatch accepts the local pin, but authorization preserves the stricter legacy ownership check.
  expect(
    resolveFolderWorkspaceHost(
      { folderWorkspaces: [pinnedFolder], projectGroups: [legacyGroup], repos: [] },
      'folder'
    )
  ).toEqual({ kind: 'local' })
  const mirrored = storeFor(
    [],
    [group({ executionHostId: 'local' }, { parentPath: null })],
    [folder({ connectionId: 'host-a' })]
  )
  expect(await getAllowedRoots(mirrored)).toEqual([])
  expect(await isPathAllowed(join(root, 'file'), mirrored)).toBe(false)
})

describe('workspace-directory fallback', () => {
  it.each([
    ['bare name', 'orca-ws'],
    ['parent traversal', '..'],
    ['relative traversal', '../orca-ws']
  ])('grants nothing for a repo-relative %s with no repo to anchor it', async (_case, dir) => {
    // `resolve` would anchor these to the main-process cwd, granting an unrelated tree.
    expect(await getAllowedRoots(storeFor([], [], [], { workspaceDir: dir }))).toEqual([])
    expect(
      await getAllowedRoots(
        storeFor([repo({ executionHostId: 'ssh:host-a' })], [], [], {
          workspaceDir: dir
        })
      )
    ).toEqual([])
  })

  // Use the real host module here; the injected flavor matrix below covers both platforms.
  it.skipIf(process.platform === 'win32')(
    'does not anchor a Windows-style workspace directory under the POSIX main-process cwd',
    async () => {
      const store = storeFor([], [], [], { workspaceDir: 'C:\\workspaces' })
      expect(await getAllowedRoots(store)).toEqual([])
      expect(await isPathAllowed(join(resolve('C:\\workspaces'), 'file'), store)).toBe(false)
    }
  )
})
