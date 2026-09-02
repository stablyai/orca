import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  assertWorktreeCleanForRemoval,
  closeLocalWatcherForWorktreePathMock,
  deleteWorktreeHistoryDirMock,
  forceDeleteLocalBranchMock,
  gitRunner,
  invalidateAuthorizedRootsCacheMock,
  join,
  listWorktrees,
  lstat,
  mkdir,
  mkdtemp,
  registerSshFilesystemProvider,
  registerSshGitProvider,
  removeWorktree,
  rm,
  runHook,
  setPlatform,
  tmpdir,
  unregisterSshFilesystemProvider,
  unregisterSshGitProvider,
  writeFile
} from '../orca-runtime-test-mocks.spec'
import type { WorktreeMeta } from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_REPO_PATH,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  createStaleRuntimeWorktreeStore,
  deferred,
  makeWorktreeMeta,
  store
} from '../orca-runtime-test-fixtures.spec'
import { createWorktreeRemovalRuntime } from '../orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  it('force-deletes a preserved branch on the qualified host when repo ids collide', async () => {
    const localRepo = store.getRepo(TEST_REPO_ID)!
    const remoteRepo = {
      ...localRepo,
      path: '/remote/repo',
      connectionId: 'ssh-1'
    }
    const remoteWorktree = {
      path: TEST_WORKTREE_PATH,
      head: 'def456',
      branch: 'feature/test',
      isBare: false,
      isMainWorktree: false
    }
    const metaById: Record<string, WorktreeMeta> = {
      [TEST_WORKTREE_ID]: makeWorktreeMeta({
        hostId: 'local',
        preserveBranchOnDelete: true
      })
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo, remoteRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      removeWorktreeMeta: (worktreeId: string, hostId?: string) => {
        if (!hostId || metaById[worktreeId]?.hostId === hostId) {
          delete metaById[worktreeId]
        }
      }
    }
    const provider = {
      exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      forceDeletePreservedBranch: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: remoteRepo.path,
          head: 'main',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        },
        remoteWorktree
      ]),
      removeWorktree: vi.fn().mockResolvedValue({
        preservedBranch: { branchName: 'feature/test', head: 'def456' }
      })
    }
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = createWorktreeRemovalRuntime(runtimeStore)

    try {
      await runtime.removeManagedWorktree(TEST_WORKTREE_ID, false, false, false, 'ssh:ssh-1')
      expect(provider.removeWorktree).toHaveBeenCalledWith(TEST_WORKTREE_PATH, false)
      expect(metaById[TEST_WORKTREE_ID]?.hostId).toBe('local')
      const result = await runtime.forceDeletePreservedBranch(
        TEST_WORKTREE_ID,
        'feature/test',
        'def456',
        'ssh:ssh-1'
      )

      expect(result).toEqual({ deleted: true })
      expect(provider.forceDeletePreservedBranch).toHaveBeenCalledWith(
        remoteRepo.path,
        'feature/test',
        'def456'
      )
      expect(forceDeleteLocalBranchMock).not.toHaveBeenCalled()
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('routes runtime preserved-branch force-delete through the selected WSL project runtime', async () => {
    setPlatform('win32')
    const runtimeStore = {
      ...store,
      getProjects: () => [
        {
          id: 'project-1',
          displayName: 'repo',
          badgeColor: 'blue',
          sourceRepoIds: [TEST_REPO_ID],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
          createdAt: 0,
          updatedAt: 0
        }
      ],
      getSettings: () => ({
        ...store.getSettings(),
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      })
    }
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    vi.mocked(removeWorktree).mockResolvedValue({
      preservedBranch: { branchName: 'feature/test', head: 'def456' }
    })
    const gitExec = vi.spyOn(gitRunner, 'gitExecFileAsync').mockResolvedValue({
      stdout: '',
      stderr: ''
    })

    await runtime.removeManagedWorktree(TEST_WORKTREE_ID)
    await runtime.forceDeletePreservedBranch(TEST_WORKTREE_ID, 'feature/test', 'def456')

    const runGit = forceDeleteLocalBranchMock.mock.calls[0]?.[3]
    expect(runGit).toEqual(expect.any(Function))
    await runGit?.(['status'], TEST_REPO_PATH)
    expect(gitExec).toHaveBeenCalledWith(['status'], {
      cwd: TEST_REPO_PATH,
      wslDistro: 'Ubuntu'
    })
  })

  it('rejects stale preserved-branch runtime cleanup actions with an old head', async () => {
    const runtime = createWorktreeRemovalRuntime()
    vi.mocked(removeWorktree).mockResolvedValue({
      preservedBranch: { branchName: 'feature/test', head: 'new456' }
    })

    await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    await expect(
      runtime.forceDeletePreservedBranch(TEST_WORKTREE_ID, 'feature/test', 'old123')
    ).rejects.toThrow('No preserved branch cleanup is pending')
    expect(forceDeleteLocalBranchMock).not.toHaveBeenCalled()
  })

  it('coalesces concurrent runtime worktree removals for the same worktree id', async () => {
    const runtime = createWorktreeRemovalRuntime()
    const removeStarted = deferred<void>()
    const finishRemoval = deferred<void>()
    vi.mocked(removeWorktree).mockImplementation(async () => {
      removeStarted.resolve()
      await finishRemoval.promise
      return {}
    })

    const first = runtime.removeManagedWorktree(TEST_WORKTREE_ID, true)
    const second = runtime.removeManagedWorktree(TEST_WORKTREE_ID, true)

    await removeStarted.promise
    await Promise.resolve()
    expect(removeWorktree).toHaveBeenCalledTimes(1)

    finishRemoval.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([{}, {}])
  })

  it('does not coalesce concurrent same-id removals on different hosts', async () => {
    const runtimeStore = {
      ...store,
      getRepos: () => [
        { ...store.getRepos()[0], executionHostId: 'local' },
        { ...store.getRepos()[0], executionHostId: 'runtime:env-1' }
      ]
    }
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    vi.spyOn(runtime, 'acquireFileWatcherRemoval').mockResolvedValue({ finish: vi.fn() })
    const bothStarted = deferred<void>()
    const finishRemovals = deferred<void>()
    let startedCount = 0
    vi.mocked(removeWorktree).mockImplementation(async () => {
      startedCount += 1
      if (startedCount === 2) {
        bothStarted.resolve()
      }
      await finishRemovals.promise
      return {}
    })

    const local = runtime.removeManagedWorktree(TEST_WORKTREE_ID, true, false, false, 'local')
    const paired = runtime.removeManagedWorktree(
      TEST_WORKTREE_ID,
      true,
      false,
      false,
      'runtime:env-1'
    )

    await bothStarted.promise
    expect(removeWorktree).toHaveBeenCalledTimes(2)

    finishRemovals.resolve()
    await expect(Promise.all([local, paired])).resolves.toEqual([{}, {}])
  })

  it('rejects concurrent runtime worktree removals for the same id with different options', async () => {
    const runtime = createWorktreeRemovalRuntime()
    const removeStarted = deferred<void>()
    const finishRemoval = deferred<void>()
    vi.mocked(removeWorktree).mockImplementation(async () => {
      removeStarted.resolve()
      await finishRemoval.promise
      return {}
    })

    const first = runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    await removeStarted.promise
    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID, true)).rejects.toThrow(
      'Worktree deletion already in progress'
    )

    expect(removeWorktree).toHaveBeenCalledTimes(1)
    finishRemoval.resolve()
    await expect(first).resolves.toEqual({})
  })

  it('treats forced runtime deletion of an already-missing unregistered worktree as cleanup', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-runtime-remove-'))
    const missingWorktreePath = join(parentDir, 'already-deleted')
    const worktreeId = `${TEST_REPO_ID}::${missingWorktreePath}`
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(worktreeId)
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    const notifier = { worktreesChanged: vi.fn() }
    runtime.setNotifier(notifier as never)

    try {
      vi.mocked(listWorktrees).mockResolvedValue([])

      await expect(runtime.removeManagedWorktree(worktreeId, true)).resolves.toEqual({})

      expect(removeWorktree).not.toHaveBeenCalled()
      // The repo resolved to the local host, so the metadata purge names it —
      // an unqualified purge would evict a same-id row owned by another host.
      expect(removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'local')
      expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
      expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
      expect(notifier.worktreesChanged).toHaveBeenCalledWith(TEST_REPO_ID)
    } finally {
      await rm(parentDir, { recursive: true, force: true })
    }
  })

  it('treats normal runtime deletion of an already-missing unregistered worktree as cleanup', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-runtime-remove-'))
    const missingWorktreePath = join(parentDir, 'already-deleted')
    const worktreeId = `${TEST_REPO_ID}::${missingWorktreePath}`
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(worktreeId)
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    const notifier = { worktreesChanged: vi.fn() }
    runtime.setNotifier(notifier as never)

    try {
      vi.mocked(listWorktrees).mockResolvedValue([])

      await expect(runtime.removeManagedWorktree(worktreeId)).resolves.toEqual({})

      expect(removeWorktree).not.toHaveBeenCalled()
      // The repo resolved to the local host, so the metadata purge names it —
      // an unqualified purge would evict a same-id row owned by another host.
      expect(removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'local')
      expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
      expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
      expect(notifier.worktreesChanged).toHaveBeenCalledWith(TEST_REPO_ID)
    } finally {
      await rm(parentDir, { recursive: true, force: true })
    }
  })

  it('routes already-missing SSH runtime history cleanup through the PTY owner', async () => {
    const repo = {
      id: 'repo-runtime-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const worktreeId = `${repo.id}::/remote/already-deleted`
    const metaById: Record<string, WorktreeMeta> = {
      [worktreeId]: makeWorktreeMeta({ hostId: 'ssh:ssh-1', orcaCreationSource: 'ssh' })
    }
    const removeWorktreeMeta = vi.fn((id: string) => {
      delete metaById[id]
    })
    const runtimeStore = {
      ...store,
      getRepos: () => [repo],
      getRepo: (id: string) => (id === repo.id ? repo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (id: string) => metaById[id],
      removeWorktreeMeta
    }
    const gitProvider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: repo.path,
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
    }
    const fsProvider = {
      stat: vi.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    }
    const deleteWorktreeHistory = vi.fn().mockResolvedValue(undefined)
    const ptyProvider = { deleteWorktreeHistory } as never
    registerSshGitProvider(repo.connectionId, gitProvider as never)
    registerSshFilesystemProvider(repo.connectionId, fsProvider as never)
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getSshProvider: () => ptyProvider
    })

    try {
      await expect(runtime.removeManagedWorktree(`id:${worktreeId}`)).resolves.toEqual({})
    } finally {
      unregisterSshGitProvider(repo.connectionId)
      unregisterSshFilesystemProvider(repo.connectionId)
    }

    expect(deleteWorktreeHistory).toHaveBeenCalledWith(worktreeId)
    expect(deleteWorktreeHistory.mock.invocationCallOrder[0]).toBeLessThan(
      removeWorktreeMeta.mock.invocationCallOrder[0]
    )
    expect(removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'ssh:ssh-1')
  })

  it('routes SSH runtime orphan-directory history cleanup through the PTY owner', async () => {
    const repo = {
      id: 'repo-runtime-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const worktreePath = '/remote/orphan'
    const worktreeId = `${repo.id}::${worktreePath}`
    const metaById: Record<string, WorktreeMeta> = {
      [worktreeId]: makeWorktreeMeta({
        hostId: 'ssh:ssh-1',
        orcaCreatedAt: Date.now(),
        orcaCreationSource: 'ssh'
      })
    }
    const removeWorktreeMeta = vi.fn((id: string) => {
      delete metaById[id]
    })
    const runtimeStore = {
      ...store,
      getRepos: () => [repo],
      getRepo: (id: string) => (id === repo.id ? repo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (id: string) => metaById[id],
      removeWorktreeMeta
    }
    const gitProvider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: repo.path,
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
    }
    const fsProvider = {
      lstat: vi.fn(async (path: string) => ({
        type: path === `${worktreePath}/.git` ? 'file' : 'directory'
      })),
      readFile: vi.fn(async (path: string) => ({
        isBinary: false,
        content:
          path === `${worktreePath}/.git`
            ? `gitdir: ${repo.path}/.git/worktrees/orphan\n`
            : `${worktreePath}/.git\n`
      })),
      deletePath: vi.fn().mockResolvedValue(undefined)
    }
    const deleteWorktreeHistory = vi.fn().mockResolvedValue(undefined)
    const ptyProvider = {
      listProcesses: vi.fn().mockResolvedValue([]),
      shutdown: vi.fn().mockResolvedValue(undefined),
      deleteWorktreeHistory
    }
    registerSshGitProvider(repo.connectionId, gitProvider as never)
    registerSshFilesystemProvider(repo.connectionId, fsProvider as never)
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getSshProvider: () => ptyProvider as never
    })

    try {
      await expect(runtime.removeManagedWorktree(`id:${worktreeId}`, true)).resolves.toEqual({})
    } finally {
      unregisterSshGitProvider(repo.connectionId)
      unregisterSshFilesystemProvider(repo.connectionId)
    }

    expect(fsProvider.deletePath).toHaveBeenCalledWith(worktreePath, true)
    expect(deleteWorktreeHistory).toHaveBeenCalledWith(worktreeId)
    expect(deleteWorktreeHistory.mock.invocationCallOrder[0]).toBeLessThan(
      removeWorktreeMeta.mock.invocationCallOrder[0]
    )
  })

  it('force-removes a legacy Orca-created runtime orphaned worktree directory after Git tracking is gone', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-runtime-orphan-'))
    const repoPath = join(parentDir, 'repo')
    const orphanPath = join(parentDir, 'orphan')
    const adminWorktreePath = join(repoPath, '.git', 'worktrees', 'orphan')
    const worktreeId = `${TEST_REPO_ID}::${orphanPath}`
    await mkdir(orphanPath, { recursive: true })
    await mkdir(adminWorktreePath, { recursive: true })
    await writeFile(join(orphanPath, '.git'), `gitdir: ${adminWorktreePath}\n`)
    await writeFile(join(adminWorktreePath, 'gitdir'), `${join(orphanPath, '.git')}\n`)
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(worktreeId, {
      createdAt: Date.now()
    })
    const runtimeStoreWithRepoPath = {
      ...runtimeStore,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: repoPath,
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1
        }
      ],
      getRepo: (id: string) =>
        id === TEST_REPO_ID
          ? {
              id: TEST_REPO_ID,
              path: repoPath,
              displayName: 'repo',
              badgeColor: 'blue',
              addedAt: 1
            }
          : undefined
    }
    const runtime = createWorktreeRemovalRuntime(runtimeStoreWithRepoPath)
    const notifier = { worktreesChanged: vi.fn() }
    runtime.setNotifier(notifier as never)

    try {
      vi.mocked(listWorktrees).mockResolvedValue([])

      await expect(runtime.removeManagedWorktree(worktreeId, true)).resolves.toEqual({})

      await expect(lstat(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(closeLocalWatcherForWorktreePathMock).toHaveBeenCalledWith(
        orphanPath,
        expect.objectContaining({ remainingMs: expect.any(Function) })
      )
      expect(removeWorktree).not.toHaveBeenCalled()
      // The repo resolved to the local host, so the metadata purge names it —
      // an unqualified purge would evict a same-id row owned by another host.
      expect(removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'local')
      expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
      expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
      expect(notifier.worktreesChanged).toHaveBeenCalledWith(TEST_REPO_ID)
    } finally {
      // Why: Windows can keep a just-inspected git admin dir busy briefly.
      await rm(parentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('prompts then force-removes an Orca-created runtime unregistered leftover directory with no git marker', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-runtime-leftover-'))
    const repoPath = join(parentDir, 'repo')
    const leftoverPath = join(parentDir, 'leftover')
    const worktreeId = `${TEST_REPO_ID}::${leftoverPath}`
    await mkdir(leftoverPath, { recursive: true })
    await writeFile(join(leftoverPath, 'leftover.txt'), 'kept until force\n')
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(worktreeId, {
      orcaCreatedAt: Date.now(),
      orcaCreationSource: 'runtime'
    })
    const runtimeStoreWithRepoPath = {
      ...runtimeStore,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: repoPath,
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1
        }
      ],
      getRepo: (id: string) =>
        id === TEST_REPO_ID
          ? {
              id: TEST_REPO_ID,
              path: repoPath,
              displayName: 'repo',
              badgeColor: 'blue',
              addedAt: 1
            }
          : undefined
    }
    const runtime = createWorktreeRemovalRuntime(runtimeStoreWithRepoPath)
    const notifier = { worktreesChanged: vi.fn() }
    runtime.setNotifier(notifier as never)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'status') {
        throw new Error('fatal: not a git repository')
      }
      return { stdout: '', stderr: '' }
    })

    try {
      vi.mocked(listWorktrees).mockResolvedValue([])

      await expect(runtime.removeManagedWorktree(worktreeId)).rejects.toThrow(
        'Worktree is no longer registered with Git but its directory remains.'
      )
      await expect(lstat(leftoverPath)).resolves.toBeTruthy()
      expect(removeWorktree).not.toHaveBeenCalled()
      expect(removeWorktreeMeta).not.toHaveBeenCalled()

      await expect(runtime.removeManagedWorktree(worktreeId, true)).resolves.toEqual({})

      await expect(lstat(leftoverPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(assertWorktreeCleanForRemoval).not.toHaveBeenCalled()
      expect(runHook).not.toHaveBeenCalled()
      expect(removeWorktree).not.toHaveBeenCalled()
      // The repo resolved to the local host, so the metadata purge names it —
      // an unqualified purge would evict a same-id row owned by another host.
      expect(removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'local')
      expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
      expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
      expect(notifier.worktreesChanged).toHaveBeenCalledWith(TEST_REPO_ID)
      expect(gitSpy).toHaveBeenCalledWith(['status', '--short'], { cwd: leftoverPath })
    } finally {
      gitSpy.mockRestore()
      await rm(parentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('rejects an Orca-created runtime unregistered local directory with a git directory', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-runtime-standalone-'))
    const repoPath = join(parentDir, 'repo')
    const standalonePath = join(parentDir, 'standalone')
    const worktreeId = `${TEST_REPO_ID}::${standalonePath}`
    await mkdir(join(standalonePath, '.git'), { recursive: true })
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(worktreeId, {
      orcaCreatedAt: Date.now(),
      orcaCreationSource: 'runtime'
    })
    const runtimeStoreWithRepoPath = {
      ...runtimeStore,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: repoPath,
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1
        }
      ],
      getRepo: (id: string) =>
        id === TEST_REPO_ID
          ? {
              id: TEST_REPO_ID,
              path: repoPath,
              displayName: 'repo',
              badgeColor: 'blue',
              addedAt: 1
            }
          : undefined
    }
    const runtime = createWorktreeRemovalRuntime(runtimeStoreWithRepoPath)

    try {
      vi.mocked(listWorktrees).mockResolvedValue([])

      await expect(runtime.removeManagedWorktree(worktreeId, true)).rejects.toThrow(
        `Refusing to delete unregistered worktree path: ${standalonePath}`
      )

      await expect(lstat(standalonePath)).resolves.toBeTruthy()
      expect(removeWorktree).not.toHaveBeenCalled()
      expect(removeWorktreeMeta).not.toHaveBeenCalled()
    } finally {
      await rm(parentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })
})
