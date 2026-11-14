import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../../../persistence/loading-store/store'
import type * as RepoWorktrees from '../../../workspaces/catalog/repo-worktrees'
import { listRepoWorktreeGraph } from '../../../workspaces/catalog/repo-worktrees'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { resolveAuthorizedPath } from './filesystem-auth'
import {
  __resetCreatedWorktreeRootsForTests,
  invalidateAuthorizedRootsCache,
  rebuildAuthorizedRootsCache,
  registerCreatedWorktreeRoot,
  resolveRegisteredWorktreePath
} from '../../worktrees/removal/registered-worktree-roots-cache'

vi.mock('../../../workspaces/catalog/repo-worktrees', async () => {
  const actual = await vi.importActual<typeof RepoWorktrees>(
    '../../../workspaces/catalog/repo-worktrees'
  )
  return {
    ...actual,
    listRepoWorktreeGraph: vi.fn()
  }
})

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
    __resetCreatedWorktreeRootsForTests()
    vi.mocked(listRepoWorktreeGraph).mockReset()
  })

  it('survives a rebuild that was already in flight when the create recovered', async () => {
    const scratch = await mkdtemp(join(await realpath(tmpdir()), 'orca-recovered-race-'))
    const recovered = join(scratch, 'feature')
    await mkdir(recovered)
    const store = makeStore()
    // Register mid-listing: the rebuild's own result was computed before this worktree existed.
    vi.mocked(listRepoWorktreeGraph).mockImplementation(async () => {
      registerCreatedWorktreeRoot(store, repo.id, recovered)
      return []
    })

    await rebuildAuthorizedRootsCache(store)

    await expect(resolveRegisteredWorktreePath(recovered, store)).resolves.toBe(resolve(recovered))
    await rm(scratch, { recursive: true, force: true })
  })

  it('retires a recovered root once the listing can see it again', async () => {
    const store = makeStore()
    registerCreatedWorktreeRoot(store, repo.id, '/linked/feature')
    vi.mocked(listRepoWorktreeGraph).mockResolvedValue([
      {
        path: '/linked/feature',
        head: '',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await rebuildAuthorizedRootsCache(store)
    await expect(resolveRegisteredWorktreePath('/linked/feature', store)).resolves.toBe(
      resolve('/linked/feature')
    )
    vi.mocked(listRepoWorktreeGraph).mockResolvedValue([])
    await rebuildAuthorizedRootsCache(store)

    await expect(resolveRegisteredWorktreePath('/linked/feature', store)).rejects.toThrow(
      'Access denied'
    )
  })
})

describe('filesystem-auth path containment', () => {
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

  it.skipIf(process.platform === 'win32')(
    'rejects paths through a symlink out of the repo, and any dangling symlink',
    async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'orca-auth-symlink-'))
      try {
        const repoPath = join(tempRoot, 'repo')
        const outsidePath = join(tempRoot, 'outside')
        await mkdir(repoPath)
        await mkdir(outsidePath)
        await symlink(outsidePath, join(repoPath, 'linked-outside'), 'dir')
        await symlink(join(outsidePath, 'new.txt'), join(repoPath, 'dangling.txt'))
        await symlink(join(repoPath, 'later.txt'), join(repoPath, 'inside.txt'))
        const store = makeStore([{ ...repo, id: 'repo-temp', path: repoPath }])

        await expect(
          resolveAuthorizedPath(join(repoPath, 'linked-outside', 'new', 'file.ts'), store)
        ).rejects.toThrow('Access denied')
        // A write follows a dangling link wherever it points, so any dangling link is refused.
        for (const name of ['dangling.txt', 'inside.txt']) {
          await expect(resolveAuthorizedPath(join(repoPath, name), store)).rejects.toThrow(
            'Access denied'
          )
        }
      } finally {
        await rm(tempRoot, { recursive: true, force: true })
      }
    }
  )
})
