import { join, posix, resolve, win32 } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/repo-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import { resolveFolderWorkspaceHost } from '../../shared/folder-workspace-execution-host'
import {
  getAllowedRoots,
  getLocalRepos,
  resolveUnanchoredWorkspaceRoot
} from './filesystem-allowed-roots'
import { isPathAllowed } from './filesystem-auth'
import {
  __resetCreatedWorktreeRootsForTests,
  invalidateAuthorizedRootsCache,
  isRegisteredWorktreePath,
  rebuildAuthorizedRootsCache,
  registerCreatedWorktreeRoot,
  registerWorktreeRootsForRepo
} from './registered-worktree-roots-cache'

const mocks = vi.hoisted(() => ({
  graph: vi.fn(),
  stat: vi.fn(),
  realpath: vi.fn(),
  workspaceRoot: vi.fn(),
  pathSettings: vi.fn(),
  projectRuntimes: vi.fn()
}))
vi.mock('node:fs/promises', () => ({ stat: mocks.stat, realpath: mocks.realpath }))
vi.mock('../repo-worktrees', () => ({ listRepoWorktreeGraph: mocks.graph, isRepoRoot: vi.fn() }))
vi.mock('./worktree-logic', () => ({
  computeWorkspaceRoot: mocks.workspaceRoot,
  getWorktreePathSettings: mocks.pathSettings
}))
vi.mock('../project-runtime-git-options', () => ({
  getWorktreeMirrorDistroForRuntime: vi.fn(),
  resolveLocalProjectRuntimesForRepos: mocks.projectRuntimes
}))

/**
 * Widened past `Repo['executionHostId']` on purpose: the union names the stamps Orca writes, while a
 * store carries whatever an older build, a hand-edited catalog or a partial migration left behind.
 * Those are exactly the stamps authorization has to place, so the matrix must be able to build them.
 */
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
  // Host ids the shared parser rejects. Each must fail closed: an owner we cannot place is not
  // evidence of a local one, and a bare `getSshTargetIdForExecutionHost` answers null for all five.
  { name: 'empty SSH target', owner: { executionHostId: 'ssh:' } },
  { name: 'undecodable SSH target', owner: { executionHostId: 'ssh:%zz' } },
  { name: 'alias-delimiter SSH target', owner: { executionHostId: 'ssh:host-a|alias' } },
  { name: 'wrong-case SSH prefix', owner: { executionHostId: 'SSH:host-a' } },
  { name: 'unknown host kind', owner: { executionHostId: 'relay:host-a' } }
]
const allowedOwners: { name: string; owner: Owner }[] = [
  { name: 'unscoped local', owner: {} },
  { name: 'explicit local', owner: { executionHostId: 'local' } },
  { name: 'blank host stamp', owner: { executionHostId: '  ' } },
  { name: 'own-store runtime', owner: { executionHostId: 'runtime:env' } }
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

describe.each(deniedOwners)('$name fixture matrix', ({ owner }) => {
  it.each([
    ['repo root', () => storeFor([repo(owner)])],
    ['group scope', () => storeFor([], [group(owner)])],
    ['folder scope', () => storeFor([], [], [folder(owner)])],
    ['folder inheriting the group', () => storeFor([], [group(owner)], [folder()])],
    [
      'local-looking group and folder over a remote child repo',
      () => storeFor([repo(owner, { path: join(root, 'child') })], [group()], [folder()])
    ]
  ])('denies the %s', (_case, build) => {
    expect(isPathAllowed(join(root, 'file'), build())).toBe(false)
  })
})

describe.each(deniedOwners)('$name filesystem ownership', ({ owner }) => {
  it('does not grant a repository root or register linked roots', async () => {
    const store = storeFor([repo(owner)])
    expect(getLocalRepos(store)).toEqual([])
    expect(isPathAllowed(join(root, 'file'), store)).toBe(false)
    registerWorktreeRootsForRepo(store, 'repo', [linked])
    registerCreatedWorktreeRoot(store, 'repo', linked)
    expect(isRegisteredWorktreePath(linked, store)).toBe(false)
    await rebuildAuthorizedRootsCache(store)
    expect(isRegisteredWorktreePath(root, store)).toBe(false)
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
    expect(isRegisteredWorktreePath(linked, store)).toBe(true)
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

it('denies a workspace pinned local under a group carrying only a legacy connection', () => {
  const pinnedFolder = folder({ executionHostId: 'local' })
  const legacyGroup = group({ connectionId: 'host-a' })
  const store = storeFor([], [legacyGroup], [pinnedFolder])
  expect(getAllowedRoots(store)).toEqual([])
  expect(isPathAllowed(join(root, 'file'), store)).toBe(false)
  // Dispatch reads the same row as local; authorization is deliberately the stricter of the two,
  // because agreeing would grant a root this store refuses today.
  expect(
    resolveFolderWorkspaceHost(
      { folderWorkspaces: [pinnedFolder], projectGroups: [legacyGroup], repos: [] },
      'folder'
    )
  ).toEqual({ kind: 'local' })
  // The mirrored row needs no such note: the workspace's own legacy connection is remote on both sides.
  const mirrored = storeFor(
    [],
    [group({ executionHostId: 'local' }, { parentPath: null })],
    [folder({ connectionId: 'host-a' })]
  )
  expect(getAllowedRoots(mirrored)).toEqual([])
  expect(isPathAllowed(join(root, 'file'), mirrored)).toBe(false)
})

it('still grants a local directory that happens to share an SSH repo path', () => {
  const store = storeFor([
    repo({ executionHostId: 'ssh:host-a' }),
    repo({}, { id: 'mine', path: root })
  ])
  expect(getAllowedRoots(store)).toEqual([root])
  expect(isPathAllowed(join(root, 'file'), store)).toBe(true)
})

describe('workspace-directory fallback', () => {
  const workspaceDir = resolve('/ws-fixture')

  it('does not widen past the roots a local repo of its own would grant', () => {
    const local = getAllowedRoots(storeFor([repo()], [], [], { workspaceDir }))
    const sshOnly = getAllowedRoots(
      storeFor([repo({ executionHostId: 'ssh:host-a' })], [], [], { workspaceDir })
    )
    expect(local).toEqual([root, workspaceDir])
    // The SSH repo's own path is gone; nothing beyond the fallback the same config already granted.
    expect(sshOnly).toEqual([workspaceDir])
    expect(
      isPathAllowed(
        join(root, 'file'),
        storeFor([repo({ connectionId: 'host-a' })], [], [], { workspaceDir })
      )
    ).toBe(false)
  })

  it('grants a workspace directory this host reads as absolute, with no local repo', () => {
    expect(getAllowedRoots(storeFor([], [], [], { workspaceDir: '/ws-fixture' }))).toEqual([
      resolve('/ws-fixture')
    ])
  })

  it.each([
    ['bare name', 'orca-ws'],
    ['parent traversal', '..'],
    ['relative traversal', '../orca-ws']
  ])('grants nothing for a repo-relative %s with no repo to anchor it', (_case, dir) => {
    // `resolve` would anchor these to the main-process cwd, granting an unrelated tree.
    expect(getAllowedRoots(storeFor([], [], [], { workspaceDir: dir }))).toEqual([])
    expect(
      getAllowedRoots(
        storeFor([repo({ executionHostId: 'ssh:host-a' })], [], [], {
          workspaceDir: dir
        })
      )
    ).toEqual([])
  })

  // Why guarded rather than injected: this is the end-to-end claim that the foreign-flavour string
  // never reaches `resolve`, so it has to run against the real host path module — and on Windows the
  // same string is a legitimate root. The flavour matrix below covers both hosts unguarded.
  it.skipIf(process.platform === 'win32')(
    'does not anchor a Windows-style workspace directory under the POSIX main-process cwd',
    () => {
      const store = storeFor([], [], [], { workspaceDir: 'C:\\workspaces' })
      expect(getAllowedRoots(store)).toEqual([])
      // The cross-platform predicate used to grant exactly this: `<cwd>/C:\workspaces`.
      expect(isPathAllowed(join(resolve('C:\\workspaces'), 'file'), store)).toBe(false)
    }
  )

  it.each([
    ['POSIX absolute on POSIX', posix, '/orca-ws', true],
    ['relative on POSIX', posix, '../orca-ws', false],
    ['Windows drive on POSIX', posix, 'C:\\orca-ws', false],
    ['Windows UNC on POSIX', posix, '\\\\wsl$\\Ubuntu\\home\\me\\ws', false],
    ['POSIX absolute on Windows', win32, '/orca-ws', true],
    ['relative on Windows', win32, '..\\orca-ws', false],
    ['Windows drive on Windows', win32, 'C:\\orca-ws', true],
    ['Windows UNC on Windows', win32, '\\\\wsl$\\Ubuntu\\home\\me\\ws', true]
  ])(
    'grants an unanchored %s workspace directory only when that host reads it as absolute',
    (_case, hostPath, dir, granted) => {
      expect(resolveUnanchoredWorkspaceRoot(dir, hostPath) !== null).toBe(granted)
    }
  )
})
