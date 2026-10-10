import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  getSshGitProviderMock,
  join,
  listWorktrees,
  lstat,
  mkdir,
  mkdtemp,
  registerSshFilesystemProvider,
  registerSshGitProvider,
  rm,
  tmpdir,
  unregisterSshFilesystemProvider
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

  it('returns capped SSH refs for empty runtime repo searches', async () => {
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
    const provider = {
      exec: vi.fn().mockImplementation((argv: string[]) => {
        if (argv[0] === 'remote') {
          return Promise.resolve({ stdout: 'origin\nupstream\n', stderr: '' })
        }
        return Promise.resolve({
          stdout: [
            'refs/remotes/origin/main\0origin/main',
            'refs/remotes/upstream/feature-x\0upstream/feature-x',
            'refs/remotes/upstream/HEAD\0upstream/HEAD',
            'refs/heads/local-only\0local-only'
          ].join('\n'),
          stderr: ''
        })
      })
    }
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const result = await runtime.searchRepoRefs('id:remote-repo', '', 2)

    expect(result).toEqual({
      refs: ['origin/main', 'upstream/feature-x'],
      refDetails: [
        { refName: 'origin/main', localBranchName: 'main' },
        { refName: 'upstream/feature-x', localBranchName: 'feature-x' }
      ],
      truncated: true
    })
    expect(provider.exec).toHaveBeenCalledWith(
      expect.arrayContaining([
        '--exclude=refs/remotes/*/HEAD',
        '--count=12',
        'refs/heads/**/**',
        'refs/heads/**/**/**',
        'refs/remotes/**/**',
        'refs/remotes/**/**/**'
      ]),
      '/home/user/repo'
    )
    expect(provider.exec).toHaveBeenCalledWith(['remote'], '/home/user/repo')
  })

  it('clamps oversized SSH ref-search limits and reports the execution cap', async () => {
    const remoteRepo = {
      id: 'remote-repo-large-limit',
      path: '/home/user/repo',
      displayName: 'remote',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-large-limit'
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: () => remoteRepo
    }
    const provider = {
      exec: vi.fn().mockImplementation((argv: string[]) => {
        if (argv[0] === 'remote') {
          return Promise.resolve({ stdout: 'origin\n', stderr: '' })
        }
        return Promise.resolve({
          stdout: 'refs/remotes/origin/main\0origin/main',
          stderr: ''
        })
      })
    }
    registerSshGitProvider('ssh-large-limit', provider as never)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const result = await runtime.searchRepoRefs(
      'id:remote-repo-large-limit',
      '',
      REPO_SEARCH_REFS_MAX_LIMIT + 1
    )

    expect(result).toEqual({
      refs: ['origin/main'],
      refDetails: [{ refName: 'origin/main', localBranchName: 'main' }],
      truncated: true
    })
    const forEachRefCall = provider.exec.mock.calls.find(
      (call) => (call[0] as string[])[0] === 'for-each-ref'
    )
    expect(forEachRefCall?.[0]).toContain('--count=4004')
  })

  it('retries runtime SSH ref searches without --exclude for older git hosts', async () => {
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
    const provider = {
      exec: vi.fn().mockImplementation((argv: string[]) => {
        if (argv[0] === 'remote') {
          return Promise.resolve({ stdout: 'origin\n', stderr: '' })
        }
        if (argv.some((arg) => arg.startsWith('--exclude=refs/remotes/'))) {
          return Promise.reject(
            Object.assign(new Error("unknown option `exclude'"), {
              stderr: "error: unknown option `exclude'"
            })
          )
        }
        return Promise.resolve({
          stdout: [
            'refs/remotes/origin/main\0origin/main',
            'refs/remotes/origin/HEAD\0origin/HEAD',
            'refs/remotes/origin/feature-x\0origin/feature-x'
          ].join('\n'),
          stderr: ''
        })
      })
    }
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const result = await runtime.searchRepoRefs('id:remote-repo', '', 1)
    const repeatedResult = await runtime.searchRepoRefs('id:remote-repo', '', 1)

    expect(result).toEqual({
      refs: ['origin/main'],
      refDetails: [{ refName: 'origin/main', localBranchName: 'main' }],
      truncated: true
    })
    expect(repeatedResult).toEqual(result)
    const forEachRefCalls = provider.exec.mock.calls.filter(
      (call) => (call[0] as string[])[0] === 'for-each-ref'
    )
    expect(forEachRefCalls).toHaveLength(3)
    expect(
      (forEachRefCalls[0][0] as string[]).some((arg) => arg.startsWith('--exclude=refs/remotes/'))
    ).toBe(true)
    expect(
      (forEachRefCalls[1][0] as string[]).some((arg) => arg.startsWith('--exclude=refs/remotes/'))
    ).toBe(false)
    expect(forEachRefCalls[1][0]).toContain('--count=108')
    expect(
      (forEachRefCalls[2][0] as string[]).some((arg) => arg.startsWith('--exclude=refs/remotes/'))
    ).toBe(false)
  })

  it('resolves SSH worktrees when manually updating lineage', async () => {
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
    const setWorktreeLineage = vi.fn((_worktreeId, lineage) => lineage)
    const listSshWorktrees = vi.fn().mockResolvedValue([
      {
        path: '/home/user/repo-child',
        head: 'abc',
        branch: 'feature/child',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: '/home/user/repo-parent',
        head: 'def',
        branch: 'feature/parent',
        isBare: false,
        isMainWorktree: false
      }
    ])
    getSshGitProviderMock.mockReturnValue({ listWorktrees: listSshWorktrees })
    const runtimeStore = {
      ...store,
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getRepos: () => [remoteRepo],
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...metaById[worktreeId], ...meta }
        return metaById[worktreeId]
      },
      getWorktreeLineage: () => undefined,
      setWorktreeLineage
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.updateManagedWorktreeMeta(`id:${childId}`, {
      lineage: { parentWorktree: `id:${parentId}` }
    })

    expect(listSshWorktrees).toHaveBeenCalledWith(remoteRepo.path)
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
    const listSshWorktrees = vi.fn().mockResolvedValue([
      {
        path: '/home/user/repo',
        head: 'abc',
        branch: 'main',
        isBare: false,
        isMainWorktree: true
      }
    ])
    getSshGitProviderMock.mockReturnValue({ listWorktrees: listSshWorktrees })
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
    const listSshWorktrees = vi.fn().mockResolvedValue([
      {
        path: '/home/user/repo',
        head: 'abc',
        branch: 'main',
        isBare: false,
        isMainWorktree: true
      }
    ])
    getSshGitProviderMock.mockReturnValue({ listWorktrees: listSshWorktrees })
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

  it('rejects SSH lineage updates when Orca worktree identity is missing', async () => {
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
    const metaById: Record<string, WorktreeMeta> = {}
    const setWorktreeLineage = vi.fn((_worktreeId: string, lineage: WorktreeLineage) => lineage)
    const fsProvider = {
      readFile: vi.fn(),
      createDir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
    getSshGitProviderMock.mockReturnValue({
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/home/user/repo-child',
          head: 'abc',
          branch: 'feature/child',
          isBare: false,
          isMainWorktree: false
        },
        {
          path: '/home/user/repo-parent',
          head: 'def',
          branch: 'feature/parent',
          isBare: false,
          isMainWorktree: false
        }
      ])
    })
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
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

    try {
      await expect(
        runtime.updateManagedWorktreeMeta(`id:${childId}`, {
          lineage: { parentWorktree: `id:${parentId}` }
        })
      ).rejects.toThrow('Worktree instance identity was unavailable')
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
    }

    expect(fsProvider.createDir).not.toHaveBeenCalled()
    expect(fsProvider.writeFile).not.toHaveBeenCalled()
    expect(setWorktreeLineage).not.toHaveBeenCalled()
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
      parentMeta: {}
    },
    {
      boundary: 'known host',
      childRepoId: TEST_REPO_ID,
      parentRepoId: TEST_REPO_ID,
      childMeta: { hostId: 'runtime:child-host' as const },
      parentMeta: { hostId: 'runtime:parent-host' as const }
    },
    {
      boundary: 'known project',
      childRepoId: TEST_REPO_ID,
      parentRepoId: TEST_REPO_ID,
      childMeta: { projectId: 'project-child' },
      parentMeta: { projectId: 'project-parent' }
    }
  ])('rejects manual lineage writes across a $boundary boundary', async (scenario) => {
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

    await expect(
      runtime.updateManagedWorktreeMeta(`id:${childId}`, {
        lineage: { parentWorktree: `id:${parentId}` }
      })
    ).rejects.toThrow(
      'Parent worktree must belong to the same repository, execution host, and project.'
    )

    expect(setWorktreeLineage).not.toHaveBeenCalled()
    expect(setWorkspaceLineage).not.toHaveBeenCalled()
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
