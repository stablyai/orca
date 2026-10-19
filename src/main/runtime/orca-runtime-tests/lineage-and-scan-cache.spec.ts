import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  join,
  listWorktrees,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  tmpdir
} from '../orca-runtime-test-mocks.spec'
import type {
  WorkspaceLineage,
  WorktreeLineage,
  WorktreeMeta
} from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  makeWorktreeInfo,
  makeWorktreeMeta,
  store
} from '../orca-runtime-test-fixtures.spec'
import { REPO_SEARCH_REFS_MAX_LIMIT } from '../../../shared/repo-search-limits'

describe('OrcaRuntimeService', () => {
  it('rejects invalid positive limits for bounded list commands', async () => {
    const runtime = new OrcaRuntimeService(store)

    await expect(runtime.getWorktreePs(-1)).rejects.toThrow('invalid_limit')
    await expect(runtime.listManagedWorktrees(undefined, 0)).rejects.toThrow('invalid_limit')
    await expect(runtime.searchRepoRefs('id:repo-1', 'main', -5)).rejects.toThrow('invalid_limit')
    await expect(runtime.searchRepoRefs('id:repo-1', 'main', Number.MAX_VALUE)).rejects.toThrow(
      'invalid_limit'
    )
  })

  it('reports no refs for an SSH repo and still reports the execution cap', async () => {
    const remoteRepo = {
      id: 'remote-repo',
      path: '/home/user/repo',
      displayName: 'remote',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: () => remoteRepo
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(runtime.searchRepoRefs('id:remote-repo', '', 5)).resolves.toEqual({
      refs: [],
      refDetails: [],
      truncated: false
    })
    await expect(
      runtime.searchRepoRefs('id:remote-repo', '', REPO_SEARCH_REFS_MAX_LIMIT + 1)
    ).resolves.toEqual({ refs: [], refDetails: [], truncated: true })
  })

  it('resolves SSH lineage updates from stored metadata when the scan cache misses', async () => {
    const remoteRepo = {
      id: 'remote-repo',
      path: '/home/user/repo',
      displayName: 'remote',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const childId = `${remoteRepo.id}::/home/user/repo-child`
    const parentId = `${remoteRepo.id}::/home/user/repo-parent`
    const metaById: Record<string, WorktreeMeta> = {
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' }),
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' })
    }
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage: WorktreeLineage) => lineage)
    const runtimeStore = {
      ...store,
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getRepos: () => [remoteRepo],
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.updateManagedWorktreeMeta(`id:${childId}`, {
      lineage: { parentWorktree: `id:${parentId}` }
    })

    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'manual'
      })
    )
  })

  it('does not resolve unknown SSH worktree ids from scan-miss fallback', async () => {
    const remoteRepo = {
      id: 'remote-repo',
      path: '/home/user/repo',
      displayName: 'remote',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const childId = `${remoteRepo.id}::/home/user/repo-child`
    const parentId = `${remoteRepo.id}::/home/user/repo-parent`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' })
    }
    const runtimeStore = {
      ...store,
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getRepos: () => [remoteRepo],
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage: vi.fn((_worktreeId: string, lineage: WorktreeLineage) => lineage)
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(
      runtime.updateManagedWorktreeMeta(`id:${childId}`, {
        lineage: { parentWorktree: `id:${parentId}` }
      })
    ).rejects.toThrow('selector_not_found')
  })

  it('rejects local lineage updates when Orca worktree identity is missing', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-lineage-'))
    const repoPath = join(tempRoot, 'repo')
    const childPath = join(tempRoot, 'child')
    const parentPath = join(tempRoot, 'parent')
    const repoId = 'local-repo'
    const childId = `${repoId}::${childPath}`
    const parentId = `${repoId}::${parentPath}`
    const metaById: Record<string, WorktreeMeta> = {}
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage: WorktreeLineage) => lineage)
    const runtimeStore = {
      ...store,
      getRepo: (id: string) =>
        id === repoId
          ? {
              id: repoId,
              path: repoPath,
              displayName: 'local',
              badgeColor: 'blue',
              addedAt: 1
            }
          : undefined,
      getRepos: () => [
        {
          id: repoId,
          path: repoPath,
          displayName: 'local',
          badgeColor: 'blue',
          addedAt: 1
        }
      ],
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage
    }
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: childPath,
        head: 'abc',
        branch: 'feature/child',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: parentPath,
        head: 'def',
        branch: 'feature/parent',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      await mkdir(childPath, { recursive: true })

      await expect(
        runtime.updateManagedWorktreeMeta(`id:${childId}`, {
          lineage: { parentWorktree: `id:${parentId}` }
        })
      ).rejects.toThrow('Worktree instance identity was unavailable')

      await expect(lstat(join(childPath, '.orca'))).rejects.toThrow()
      await expect(lstat(join(parentPath, '.orca'))).rejects.toThrow()
      expect(setWorktreeLineage).not.toHaveBeenCalled()
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('keeps workspace lineage in sync when manually reparenting a worktree', async () => {
    const parentPath = '/tmp/worktree-parent'
    const childPath = '/tmp/worktree-child'
    const parentId = `${TEST_REPO_ID}::${parentPath}`
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance' }),
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage: WorktreeLineage) => lineage)
    const setWorkspaceLineage = vi.fn((lineage: WorkspaceLineage) => lineage)
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage,
      setWorkspaceLineage
    }
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: parentPath,
        head: 'abc',
        branch: 'feature/parent',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: childPath,
        head: 'def',
        branch: 'feature/child',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.updateManagedWorktreeMeta(`id:${childId}`, {
      lineage: { parentWorktree: `id:${parentId}` }
    })

    expect(setWorktreeLineage).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'parent-instance',
        capture: { source: 'manual-action', confidence: 'explicit' }
      })
    )
    expect(setWorkspaceLineage).toHaveBeenCalledWith(
      expect.objectContaining({
        childWorkspaceKey: `worktree:${childId}`,
        childInstanceId: 'child-instance',
        parentWorkspaceKey: `worktree:${parentId}`,
        parentInstanceId: 'parent-instance',
        capture: { source: 'manual-action', confidence: 'explicit' }
      })
    )
  })

  it.each([
    {
      boundary: 'repository',
      childRepoId: 'repo-child',
      parentRepoId: 'repo-parent',
      childMeta: {},
      parentMeta: {},
      accepted: true
    },
    {
      boundary: 'known host',
      childRepoId: TEST_REPO_ID,
      parentRepoId: TEST_REPO_ID,
      childMeta: { hostId: 'runtime:child-host' as const },
      parentMeta: { hostId: 'runtime:parent-host' as const },
      accepted: false
    },
    {
      boundary: 'known project',
      childRepoId: TEST_REPO_ID,
      parentRepoId: TEST_REPO_ID,
      childMeta: { projectId: 'project-child' },
      parentMeta: { projectId: 'project-parent' },
      accepted: true
    }
  ])('checks manual lineage writes across a $boundary boundary', async (scenario) => {
    const repos = [...new Set([scenario.childRepoId, scenario.parentRepoId])].map((id) => ({
      id,
      path: join(tmpdir(), id),
      displayName: id,
      badgeColor: 'blue' as const,
      addedAt: 1
    }))
    const childRepoPath = repos.find((repo) => repo.id === scenario.childRepoId)!.path
    const parentRepoPath = repos.find((repo) => repo.id === scenario.parentRepoId)!.path
    const childPath = join(childRepoPath, 'child')
    const parentPath = join(parentRepoPath, 'parent')
    const childId = `${scenario.childRepoId}::${childPath}`
    const parentId = `${scenario.parentRepoId}::${parentPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance', ...scenario.childMeta }),
      [parentId]: makeWorktreeMeta({ instanceId: 'parent-instance', ...scenario.parentMeta })
    }
    const setWorktreeLineage = vi.fn()
    const setWorkspaceLineage = vi.fn()
    const runtimeStore = {
      ...store,
      getRepos: () => repos,
      getRepo: (id: string) => repos.find((repo) => repo.id === id),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage,
      setWorkspaceLineage
    }
    vi.mocked(listWorktrees).mockImplementation(async (repoPath) => [
      ...(repoPath === childRepoPath ? [makeWorktreeInfo(childPath)] : []),
      ...(repoPath === parentRepoPath ? [makeWorktreeInfo(parentPath)] : [])
    ])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const update = runtime.updateManagedWorktreeMeta(`id:${childId}`, {
      lineage: { parentWorktree: `id:${parentId}` }
    })
    if (scenario.accepted) {
      await update
      expect(setWorktreeLineage).toHaveBeenCalledWith(
        childId,
        expect.objectContaining({ parentWorktreeId: parentId })
      )
      expect(setWorkspaceLineage).toHaveBeenCalled()
    } else {
      await expect(update).rejects.toThrow('Parent worktree must be on the same execution host.')
      expect(setWorktreeLineage).not.toHaveBeenCalled()
      expect(setWorkspaceLineage).not.toHaveBeenCalled()
    }
  })

  it('clears workspace lineage when manually removing a parent', async () => {
    const childPath = '/tmp/worktree-child'
    const childId = `${TEST_REPO_ID}::${childPath}`
    const metaById: Record<string, WorktreeMeta> = {
      [childId]: makeWorktreeMeta({ instanceId: 'child-instance' })
    }
    const removeWorktreeLineage = vi.fn()
    const removeWorkspaceLineage = vi.fn()
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      removeWorktreeLineage,
      removeWorkspaceLineage
    }
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: childPath,
        head: 'def',
        branch: 'feature/child',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.updateManagedWorktreeMeta(`id:${childId}`, {
      lineage: { noParent: true }
    })

    expect(removeWorktreeLineage).toHaveBeenCalledWith(childId)
    expect(removeWorkspaceLineage).toHaveBeenCalledWith(`worktree:${childId}`)
  })
})
