import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type * as RepoWorktrees from '../repo-worktrees'
import { listRepoWorktreeGraph } from '../repo-worktrees'
import type * as ProjectGroupsModule from '../../shared/project-groups'
import { buildProjectGroupChildIndex, getProjectGroupSubtreeIds } from '../../shared/project-groups'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { getWorktreeMirrorDistro } from '../project-runtime-git-options'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Project } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import { getAllowedRoots } from './filesystem-allowed-roots'
import { authorizeExternalPath, resolveAuthorizedPath } from './filesystem-auth'
import { invalidateAuthorizedRootsCache } from './registered-worktree-roots-cache'
import { computeWorkspaceRoot, getWorktreePathSettings } from './worktree-logic'

vi.mock('../repo-worktrees', async () => {
  const actual = await vi.importActual<typeof RepoWorktrees>('../repo-worktrees')
  return { ...actual, listRepoWorktreeGraph: vi.fn(async () => []) }
})

vi.mock('../../shared/project-groups', async () => {
  const actual = await vi.importActual<typeof ProjectGroupsModule>('../../shared/project-groups')
  return {
    ...actual,
    buildProjectGroupChildIndex: vi.fn(actual.buildProjectGroupChildIndex),
    getProjectGroupSubtreeIds: vi.fn(actual.getProjectGroupSubtreeIds)
  }
})

type StoreFixture = {
  repos: Repo[]
  projects: Project[]
  projectGroups: ProjectGroup[]
  folderWorkspaces: FolderWorkspace[]
  workspaceDir?: string
}

type StoreCallCounts = {
  getRepos: number
  getProjects: number
  getProjectGroups: number
  getFolderWorkspaces: number
}

function makeCountingStore(fixture: StoreFixture): { store: Store; counts: StoreCallCounts } {
  const counts: StoreCallCounts = {
    getRepos: 0,
    getProjects: 0,
    getProjectGroups: 0,
    getFolderWorkspaces: 0
  }
  const store = {
    getRepos: () => {
      counts.getRepos += 1
      // Match the real store, which rehydrates fresh repo objects on every read.
      return fixture.repos.map((repo) => ({ ...repo }))
    },
    getProjects: () => {
      counts.getProjects += 1
      return fixture.projects.map((project) => ({ ...project }))
    },
    getProjectGroups: () => {
      counts.getProjectGroups += 1
      return fixture.projectGroups.map((group) => ({ ...group }))
    },
    getFolderWorkspaces: () => {
      counts.getFolderWorkspaces += 1
      return fixture.folderWorkspaces.map((workspace) => ({ ...workspace }))
    },
    getSettings: () => ({ nestWorkspaces: false, workspaceDir: fixture.workspaceDir ?? '' })
  } as unknown as Store
  return { store, counts }
}

/**
 * The pre-change `getAllowedRoots` algorithm, kept verbatim so the equivalence test compares the
 * new root list against the old one rather than against a hand-written expectation.
 */
function referenceAllowedRoots(store: Store): string[] {
  const scopeStore = store as unknown as {
    getRepos: () => Repo[]
    getProjectGroups?: () => ProjectGroup[]
    getFolderWorkspaces?: () => FolderWorkspace[]
    getSettings: () => { workspaceDir?: string; nestWorkspaces?: boolean }
  }
  const localRepos = scopeStore.getRepos().filter((repo) => !repo.connectionId)
  const settings = scopeStore.getSettings()

  const scopeRepos = scopeStore.getRepos()
  const projectGroups = scopeStore.getProjectGroups?.() ?? []
  const isRemoteOnly = (
    folderPath: string,
    projectGroupId: string,
    connectionId: string | null | undefined
  ): boolean => {
    if (connectionId) {
      return true
    }
    const groupIds = getProjectGroupSubtreeIds(projectGroups, projectGroupId)
    const candidates = scopeRepos.filter(
      (repo) =>
        (typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)) ||
        isPathInsideOrEqual(folderPath, repo.path)
    )
    return candidates.length > 0 && candidates.every((repo) => Boolean(repo.connectionId))
  }
  const folderScopeRoots: string[] = []
  for (const group of projectGroups) {
    if (group.parentPath && !isRemoteOnly(group.parentPath, group.id, group.connectionId)) {
      folderScopeRoots.push(resolve(group.parentPath))
    }
  }
  for (const workspace of scopeStore.getFolderWorkspaces?.() ?? []) {
    const connectionId =
      workspace.connectionId ??
      projectGroups.find((group) => group.id === workspace.projectGroupId)?.connectionId ??
      null
    if (!isRemoteOnly(workspace.folderPath, workspace.projectGroupId, connectionId)) {
      folderScopeRoots.push(resolve(workspace.folderPath))
    }
  }

  const roots = [...localRepos.map((repo) => resolve(repo.path)), ...folderScopeRoots]
  if (settings.workspaceDir) {
    if (localRepos.length === 0) {
      roots.push(resolve(settings.workspaceDir))
    } else {
      for (const repo of localRepos) {
        roots.push(
          resolve(
            computeWorkspaceRoot(
              repo.path,
              getWorktreePathSettings(repo, settings as never, getWorktreeMirrorDistro(store, repo))
            )
          )
        )
      }
    }
  }
  return roots
}

function makeRepo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'path'>): Repo {
  return {
    displayName: overrides.id,
    badgeColor: '#000000',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

function makeGroup(overrides: Partial<ProjectGroup> & Pick<ProjectGroup, 'id'>): ProjectGroup {
  return {
    name: overrides.id,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeWorkspace(
  overrides: Partial<FolderWorkspace> & Pick<FolderWorkspace, 'id' | 'folderPath'>
): FolderWorkspace {
  return {
    projectGroupId: 'group-root',
    name: overrides.id,
    comment: '',
    linkedTask: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

/** Repos, nested groups, folder workspaces (one not a git worktree), and an SSH repo. */
function makeMixedFixture(): StoreFixture {
  const repos = [
    makeRepo({ id: 'repo-local', path: '/repos/app', projectGroupId: 'group-root' }),
    makeRepo({ id: 'repo-nested', path: '/repos/nested', projectGroupId: 'group-child' }),
    makeRepo({ id: 'repo-folder', path: '/folders/plain', kind: 'folder' }),
    makeRepo({
      id: 'repo-ssh',
      path: '/remote/app',
      connectionId: 'ssh-1',
      projectGroupId: 'group-remote'
    })
  ]
  const projectGroups = [
    makeGroup({ id: 'group-root', parentPath: '/folders/root' }),
    makeGroup({ id: 'group-child', parentGroupId: 'group-root', parentPath: '/folders/child' }),
    makeGroup({ id: 'group-grandchild', parentGroupId: 'group-child' }),
    makeGroup({ id: 'group-remote', parentPath: '/remote/scope' }),
    makeGroup({ id: 'group-connection', parentPath: '/remote/via-group', connectionId: 'ssh-1' })
  ]
  const folderWorkspaces = [
    makeWorkspace({ id: 'ws-git', folderPath: '/folders/root/feature' }),
    // Not a git worktree: a plain folder workspace under a folder-kind repo.
    makeWorkspace({
      id: 'ws-plain',
      folderPath: '/folders/plain/scratch',
      projectGroupId: 'group-child'
    }),
    makeWorkspace({ id: 'ws-remote', folderPath: '/remote/ws', projectGroupId: 'group-remote' }),
    makeWorkspace({
      id: 'ws-connection',
      folderPath: '/remote/direct',
      projectGroupId: 'group-connection'
    }),
    makeWorkspace({
      id: 'ws-unlinked',
      folderPath: '/folders/unlinked',
      projectGroupId: 'group-orphan'
    })
  ]
  const projects: Project[] = [
    {
      id: 'project-1',
      displayName: 'App',
      badgeColor: '#000000',
      sourceRepoIds: ['repo-local', 'repo-nested'],
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'project-2',
      displayName: 'Folder',
      badgeColor: '#000000',
      sourceRepoIds: ['repo-folder'],
      createdAt: 1,
      updatedAt: 1
    }
  ]
  return { repos, projects, projectGroups, folderWorkspaces, workspaceDir: '/workspaces' }
}

beforeEach(() => {
  invalidateAuthorizedRootsCache()
  vi.mocked(buildProjectGroupChildIndex).mockClear()
  vi.mocked(getProjectGroupSubtreeIds).mockClear()
})

describe('getAllowedRoots', () => {
  it('produces the same roots as the pre-change implementation', () => {
    const { store } = makeCountingStore(makeMixedFixture())

    expect(getAllowedRoots(store)).toEqual(referenceAllowedRoots(store))
  })

  it('reads the store once and indexes project groups once per build', () => {
    const fixture = makeMixedFixture()
    const { store, counts } = makeCountingStore(fixture)

    getAllowedRoots(store)

    expect.soft(counts.getRepos).toBe(1)
    expect.soft(counts.getProjectGroups).toBe(1)
    expect.soft(counts.getFolderWorkspaces).toBe(1)
    // Batched runtime resolution scans the project list once, not once per local repo.
    expect.soft(counts.getProjects).toBe(1)
    // The per-scope subtree walk no longer rebuilds the parent->children index.
    expect.soft(vi.mocked(buildProjectGroupChildIndex)).toHaveBeenCalledTimes(1)
    expect.soft(vi.mocked(getProjectGroupSubtreeIds)).not.toHaveBeenCalled()
  })
})

describe('resolveAuthorizedPath allowed-root reuse', () => {
  let repoRoot: string
  let outsideRoot: string
  let store: Store
  let counts: StoreCallCounts

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(await realpath(tmpdir()), 'orca-allowed-roots-'))
    outsideRoot = await mkdtemp(join(await realpath(tmpdir()), 'orca-outside-'))
    const fixture = makeMixedFixture()
    fixture.repos = [makeRepo({ id: 'repo-local', path: repoRoot }), ...fixture.repos]
    fixture.projects[0]!.sourceRepoIds = ['repo-local']
    ;({ store, counts } = makeCountingStore(fixture))
  })

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
    await rm(outsideRoot, { recursive: true, force: true })
  })

  it('builds the allowed-root list once per call across repeated reads', async () => {
    const dirPath = join(repoRoot, 'src')
    await mkdir(dirPath)
    await writeFile(join(dirPath, 'index.ts'), 'export {}\n')
    const callCount = 5

    for (let index = 0; index < callCount; index += 1) {
      await resolveAuthorizedPath(dirPath, store)
      await resolveAuthorizedPath(join(dirPath, 'index.ts'), store)
    }

    const buildCount = callCount * 2
    // One build per authorization, not one per raw-path check plus one per realpath check.
    expect.soft(counts.getFolderWorkspaces).toBe(buildCount)
    expect.soft(counts.getRepos).toBe(buildCount)
    expect.soft(counts.getProjects).toBe(buildCount)
    expect.soft(vi.mocked(buildProjectGroupChildIndex)).toHaveBeenCalledTimes(buildCount)
    expect.soft(vi.mocked(getProjectGroupSubtreeIds)).not.toHaveBeenCalled()
  })

  // Why (both symlink cases): creating a symlink on Windows needs elevation or
  // Developer Mode, so these would fail EPERM in setup rather than exercise the
  // escape check. Every non-symlink case still runs there.
  it.skipIf(process.platform === 'win32')(
    'still refuses a symlink that escapes every allowed root',
    async () => {
      const secret = join(outsideRoot, 'secret.txt')
      await writeFile(secret, 'secret\n')
      const escape = join(repoRoot, 'escape.txt')
      await symlink(secret, escape)

      await expect(resolveAuthorizedPath(escape, store)).rejects.toThrow('Access denied')
      expect(vi.mocked(listRepoWorktreeGraph)).toHaveBeenCalled()
    }
  )

  it('builds no allowed-root list at all for a granted external path', async () => {
    const external = join(outsideRoot, 'external.md')
    await writeFile(external, 'notes\n')
    authorizeExternalPath(external)
    counts.getRepos = 0
    counts.getProjects = 0
    counts.getFolderWorkspaces = 0

    for (let index = 0; index < 5; index += 1) {
      await expect(resolveAuthorizedPath(external, store)).resolves.toBe(external)
    }

    // The grant answers on its own; hoisting the snapshot must not turn zero builds into one per read.
    expect.soft(counts.getRepos).toBe(0)
    expect.soft(counts.getProjects).toBe(0)
    expect.soft(counts.getFolderWorkspaces).toBe(0)
    expect.soft(vi.mocked(buildProjectGroupChildIndex)).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'still refuses a directory symlink that escapes every allowed root',
    async () => {
      const outsideDir = join(outsideRoot, 'nested')
      await mkdir(outsideDir)
      await writeFile(join(outsideDir, 'file.txt'), 'secret\n')
      const escape = join(repoRoot, 'escape-dir')
      await symlink(outsideDir, escape)

      await expect(resolveAuthorizedPath(join(escape, 'file.txt'), store)).rejects.toThrow(
        'Access denied'
      )
    }
  )
})
