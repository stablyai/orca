import type * as NodePath from 'node:path'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type * as RepoWorktrees from '../repo-worktrees'
import { listRepoWorktrees } from '../repo-worktrees'
import type { FolderWorkspace, GitWorktreeInfo, ProjectGroup, Repo } from '../../shared/types'
import {
  AUTHORIZED_EXTERNAL_PATHS_MAX,
  authorizeExternalPath,
  invalidateAuthorizedRootsCache,
  isDescendantOrEqual,
  isPathAllowed,
  rebuildAuthorizedRootsCache,
  resolveAuthorizedPath,
  resolveRegisteredWorktreePath,
  validateGitRelativeFilePath
} from './filesystem-auth'

vi.mock('../repo-worktrees', async () => {
  const actual = await vi.importActual<typeof RepoWorktrees>('../repo-worktrees')
  return {
    ...actual,
    listRepoWorktrees: vi.fn()
  }
})

const LARGE_WORKTREE_ROOT_COUNT = 150_000

const repo: Repo = {
  id: 'repo-1',
  path: '/repos/app',
  displayName: 'app',
  badgeColor: '#000000',
  addedAt: 1,
  kind: 'git'
}

function makeProjectGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Workspace',
    parentPath: '/folders/workspace',
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

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-workspace-1',
    projectGroupId: 'group-1',
    name: 'Feature',
    folderPath: '/folders/workspace',
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

function makeStore(
  repos: Repo[] = [repo],
  options: {
    projectGroups?: ProjectGroup[]
    folderWorkspaces?: FolderWorkspace[]
  } = {}
): Store {
  return {
    getRepos: () => repos,
    getProjectGroups: () => options.projectGroups ?? [],
    getFolderWorkspaces: () => options.folderWorkspaces ?? [],
    getSettings: () => ({})
  } as unknown as Store
}

describe('filesystem auth worktree roots', () => {
  beforeEach(() => {
    invalidateAuthorizedRootsCache()
    vi.mocked(listRepoWorktrees).mockReset()
  })

  it('rebuilds the authorized roots cache for large worktree lists', async () => {
    const worktrees: GitWorktreeInfo[] = Array.from(
      { length: LARGE_WORKTREE_ROOT_COUNT },
      (_, index) => ({
        path: `/linked/worktree-${index}`,
        head: '',
        branch: `refs/heads/generated-${index}`,
        isBare: false,
        isMainWorktree: false
      })
    )
    vi.mocked(listRepoWorktrees).mockResolvedValue(worktrees)
    const store = makeStore()

    await rebuildAuthorizedRootsCache(store)

    const lastWorktreePath = `/linked/worktree-${LARGE_WORKTREE_ROOT_COUNT - 1}`
    await expect(resolveRegisteredWorktreePath(lastWorktreePath, store)).resolves.toBe(
      resolve(lastWorktreePath)
    )
    expect(listRepoWorktrees).toHaveBeenCalledTimes(1)
  })

  it('bounds concurrent repo probes while rebuilding authorized roots', async () => {
    const repos = Array.from({ length: 20 }, (_, index) => ({
      ...repo,
      id: `repo-${index}`,
      path: `/repos/app-${index}`
    }))
    let active = 0
    let maxActive = 0
    vi.mocked(listRepoWorktrees).mockImplementation(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
      return []
    })

    await rebuildAuthorizedRootsCache(makeStore(repos))

    expect(listRepoWorktrees).toHaveBeenCalledTimes(repos.length)
    expect(maxActive).toBeLessThanOrEqual(8)
  })
})

describe('filesystem-auth path containment', () => {
  it('authorizes missing nested descendants under an allowed repo', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-auth-missing-'))
    try {
      const repoPath = join(tempRoot, 'repo')
      await mkdir(repoPath)
      const store = makeStore([{ ...repo, id: 'repo-temp', path: repoPath }])
      const targetPath = join(repoPath, 'new', 'nested', 'file.ts')

      await expect(resolveAuthorizedPath(targetPath, store)).resolves.toBe(
        join(await realpath(repoPath), 'new', 'nested', 'file.ts')
      )
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('authorizes local folder workspace roots outside child repo roots', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-auth-folder-workspace-'))
    try {
      const folderPath = join(tempRoot, 'platform')
      const repoPath = join(folderPath, 'web')
      await mkdir(repoPath, { recursive: true })
      const projectGroup = makeProjectGroup({ parentPath: folderPath })
      const folderWorkspace = makeFolderWorkspace({ folderPath, projectGroupId: projectGroup.id })
      const store = makeStore([{ ...repo, id: 'repo-temp', path: repoPath }], {
        projectGroups: [projectGroup],
        folderWorkspaces: [folderWorkspace]
      })

      await expect(resolveAuthorizedPath(folderPath, store)).resolves.toBe(
        await realpath(folderPath)
      )
      await expect(resolveAuthorizedPath(join(folderPath, 'notes.md'), store)).resolves.toBe(
        join(await realpath(folderPath), 'notes.md')
      )
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('authorizes local folder-backed project group roots outside child repo roots', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-auth-project-group-'))
    try {
      const folderPath = join(tempRoot, 'platform')
      const repoPath = join(folderPath, 'web')
      await mkdir(repoPath, { recursive: true })
      const projectGroup = makeProjectGroup({ parentPath: folderPath })
      const store = makeStore([{ ...repo, id: 'repo-temp', path: repoPath }], {
        projectGroups: [projectGroup]
      })

      await expect(resolveAuthorizedPath(folderPath, store)).resolves.toBe(
        await realpath(folderPath)
      )
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('does not authorize SSH-only folder workspace roots as local paths', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-auth-remote-folder-workspace-'))
    try {
      const folderPath = join(tempRoot, 'remote-platform')
      const repoPath = join(folderPath, 'web')
      await mkdir(repoPath, { recursive: true })
      const projectGroup = makeProjectGroup({ parentPath: folderPath })
      const folderWorkspace = makeFolderWorkspace({ folderPath, projectGroupId: projectGroup.id })
      const store = makeStore(
        [{ ...repo, id: 'repo-temp', path: repoPath, connectionId: 'ssh-1' }],
        {
          projectGroups: [projectGroup],
          folderWorkspaces: [folderWorkspace]
        }
      )

      await expect(resolveAuthorizedPath(folderPath, store)).rejects.toThrow('Access denied')
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('does not authorize repo-less SSH-provenance folder roots as local paths', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-auth-remote-folder-provenance-'))
    try {
      const folderPath = join(tempRoot, 'remote-platform')
      await mkdir(folderPath, { recursive: true })
      const projectGroup = makeProjectGroup({ parentPath: folderPath, connectionId: 'ssh-1' })
      const folderWorkspace = makeFolderWorkspace({
        folderPath,
        projectGroupId: projectGroup.id,
        connectionId: 'ssh-1'
      })
      const store = makeStore([], {
        projectGroups: [projectGroup],
        folderWorkspaces: [folderWorkspace]
      })

      await expect(resolveAuthorizedPath(folderPath, store)).rejects.toThrow('Access denied')
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('does not authorize SSH-only folder-backed project group roots as local paths', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-auth-remote-project-group-'))
    try {
      const folderPath = join(tempRoot, 'remote-platform')
      const repoPath = join(folderPath, 'web')
      await mkdir(repoPath, { recursive: true })
      const projectGroup = makeProjectGroup({ parentPath: folderPath })
      const store = makeStore(
        [{ ...repo, id: 'repo-temp', path: repoPath, connectionId: 'ssh-1' }],
        {
          projectGroups: [projectGroup]
        }
      )

      await expect(resolveAuthorizedPath(folderPath, store)).rejects.toThrow('Access denied')
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'rejects missing descendants under a symlinked ancestor outside the repo',
    async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'orca-auth-symlink-'))
      try {
        const repoPath = join(tempRoot, 'repo')
        const outsidePath = join(tempRoot, 'outside')
        await mkdir(repoPath)
        await mkdir(outsidePath)
        await symlink(outsidePath, join(repoPath, 'linked-outside'), 'dir')
        const store = makeStore([{ ...repo, id: 'repo-temp', path: repoPath }])

        await expect(
          resolveAuthorizedPath(join(repoPath, 'linked-outside', 'new', 'file.ts'), store)
        ).rejects.toThrow('Access denied')
      } finally {
        await rm(tempRoot, { recursive: true, force: true })
      }
    }
  )

  it('allows descendants whose path segment starts with dotdot characters', () => {
    const root = resolve('/workspace/repo')
    const child = resolve('/workspace/repo/..fixtures/file.ts')

    expect(isDescendantOrEqual(child, root)).toBe(true)
  })

  it('allows git-relative files under dotdot-prefixed child directories', () => {
    expect(validateGitRelativeFilePath(resolve('/workspace/repo'), '..fixtures/file.ts')).toBe(
      join('..fixtures', 'file.ts')
    )
  })

  it('still rejects parent-directory escapes', () => {
    const root = resolve('/workspace/repo')
    const outside = resolve('/workspace/repo/../other/file.ts')

    expect(isDescendantOrEqual(outside, root)).toBe(false)
    expect(() => validateGitRelativeFilePath(root, '../other/file.ts')).toThrow(
      'Access denied: git file path escapes the selected worktree'
    )
  })

  it('accepts Windows descendants when drive and root casing differ', async () => {
    vi.resetModules()
    vi.doMock('../repo-worktrees', () => ({
      isRepoRoot: vi.fn(),
      listRepoWorktrees: vi.fn()
    }))
    vi.doMock('path', async () => {
      const path = await vi.importActual<typeof NodePath>('node:path')
      return {
        ...path.win32,
        default: path.win32
      }
    })

    try {
      const { isDescendantOrEqual: isDescendantOrEqualWithWinPath } =
        await import('./filesystem-auth')

      expect(
        isDescendantOrEqualWithWinPath(String.raw`c:\repo\src\app.ts`, String.raw`C:\Repo`)
      ).toBe(true)
      expect(
        isDescendantOrEqualWithWinPath(String.raw`D:\repo\src\app.ts`, String.raw`C:\Repo`)
      ).toBe(false)
    } finally {
      vi.doUnmock('path')
      vi.doUnmock('../repo-worktrees')
      vi.resetModules()
    }
  })
})

describe('filesystem-auth authorized external path bound', () => {
  // Empty allow-list store, so a path is allowed only if it (or an ancestor) is
  // in the session-authorized external-path set.
  const emptyStore = makeStore([])
  const flood = (n: number): string =>
    resolve(`/leak-audit-ext/flood-${String(n).padStart(6, '0')}`)

  it('bounds the authorized external path set with LRU eviction', () => {
    const keep = resolve('/leak-audit-ext/keep')
    authorizeExternalPath(keep)

    // Flood past the cap with distinct external paths, re-authorizing `keep`
    // periodically so LRU keeps it hot.
    const total = AUTHORIZED_EXTERNAL_PATHS_MAX + 200
    for (let i = 0; i < total; i += 1) {
      authorizeExternalPath(flood(i))
      if (i % 250 === 0) {
        authorizeExternalPath(keep)
      }
    }

    // The oldest never-re-touched entries fell out of the bounded set...
    expect(isPathAllowed(flood(0), emptyStore)).toBe(false)
    // ...while the periodically re-authorized path and the most recent survive.
    expect(isPathAllowed(keep, emptyStore)).toBe(true)
    expect(isPathAllowed(flood(total - 1), emptyStore)).toBe(true)
  })

  it('re-authorizes an evicted path on next use (self-healing)', () => {
    const path = resolve('/leak-audit-ext/evicted-then-reused')
    for (let i = 0; i < AUTHORIZED_EXTERNAL_PATHS_MAX + 50; i += 1) {
      authorizeExternalPath(flood(100_000 + i))
    }
    expect(isPathAllowed(path, emptyStore)).toBe(false)
    authorizeExternalPath(path)
    expect(isPathAllowed(path, emptyStore)).toBe(true)
  })
})
