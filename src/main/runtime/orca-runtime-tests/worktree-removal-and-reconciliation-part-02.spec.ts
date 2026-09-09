import { describe, expect, it, vi } from 'vitest'
import {
  MOCK_GIT_WORKTREES,
  ORIGINAL_PLATFORM,
  OrcaRuntimeService,
  WATCHER_REMOVAL_DRAIN_BUDGET_MS,
  assertWorktreeCleanForRemoval,
  beginWatcherInstall,
  closeLocalWatcherForWorktreePathMock,
  closeRemoteWatcherForWorktreePathMock,
  deleteWorktreeHistoryDirMock,
  forceDeleteLocalBranchMock,
  forgetLocalWatcherRemovalSnapshotMock,
  forgetRemoteWatcherRemovalSnapshotMock,
  getEffectiveHooks,
  gitRunner,
  join,
  listWorktrees,
  listWorktreesStrict,
  localWorktreeFilesystem,
  lstat,
  mkdir,
  registerSshGitProvider,
  removeWorktree,
  removeWorktreeLinkedPathsMock,
  restoreLocalWatcherAfterFailedRemovalMock,
  restoreRemoteWatcherAfterFailedRemovalMock,
  rm,
  runHook,
  setPlatform,
  unregisterSshGitProvider,
  writeFile
} from '../orca-runtime-test-mocks.spec'
import type { WorktreeMeta } from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_REPO_PATH,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  createRuntime,
  createStaleRuntimeWorktreeStore,
  makeWorktreeMeta,
  store,
  syncSinglePty
} from '../orca-runtime-test-fixtures.spec'
import { createWorktreeRemovalRuntime } from '../orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  it('warns that a missing-repo removal only forgot the workspace', async () => {
    const { runtimeStore } = createStaleRuntimeWorktreeStore(TEST_WORKTREE_ID, {
      hostId: 'runtime:env-1'
    })
    const orphanStore = {
      ...runtimeStore,
      getRepos: () => [],
      getRepo: () => undefined
    }
    const runtime = createWorktreeRemovalRuntime(orphanStore)

    const result = await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    // Regression: CLI and mobile share this method, so success alone must not read as "deleted".
    expect(result.warning).toEqual(expect.stringContaining(TEST_WORKTREE_PATH))
    expect(result.warning).toEqual(expect.stringContaining(TEST_REPO_ID))
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('sweeps an orphaned SSH worktree through its host provider', async () => {
    const { runtimeStore } = createStaleRuntimeWorktreeStore(TEST_WORKTREE_ID, {
      hostId: 'ssh:ssh-1'
    })
    const orphanStore = {
      ...runtimeStore,
      getRepos: () => [],
      getRepo: () => undefined
    }
    const localProvider = {
      listProcesses: vi.fn(async () => []),
      shutdown: vi.fn(async () => {})
    }
    const sshProvider = {
      listProcesses: vi.fn(async () => []),
      shutdown: vi.fn(async () => {})
    }
    const getSshProvider = vi.fn(() => sshProvider as never)
    const runtime = new OrcaRuntimeService(orphanStore as never, undefined, {
      getLocalProvider: () => localProvider as never,
      getSshProvider
    })

    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID)).resolves.toEqual({
      warning: expect.stringContaining(TEST_WORKTREE_PATH)
    })

    expect(getSshProvider).toHaveBeenCalledWith('ssh-1')
    expect(sshProvider.listProcesses).toHaveBeenCalled()
    expect(localProvider.listProcesses).not.toHaveBeenCalled()
    expect(closeRemoteWatcherForWorktreePathMock).toHaveBeenCalledWith('ssh-1', TEST_WORKTREE_PATH)
    // The remote directory survives, so its watchers are restored, not forgotten.
    expect(restoreRemoteWatcherAfterFailedRemovalMock).toHaveBeenCalledWith(
      'ssh-1',
      TEST_WORKTREE_PATH
    )
    expect(forgetRemoteWatcherRemovalSnapshotMock).not.toHaveBeenCalled()
  })

  it('does not remove a runtime worktree when watcher teardown cannot release it', async () => {
    const repo = { ...store.getRepos()[0], symlinkPaths: ['node_modules'] }
    const runtimeStore = { ...store, getRepos: () => [repo], getRepo: () => repo }
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    deleteWorktreeHistoryDirMock.mockClear()
    closeLocalWatcherForWorktreePathMock.mockRejectedValue(
      new Error('file watcher process did not exit after termination deadline')
    )

    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID)).rejects.toThrow(
      'file watcher process did not exit after termination deadline'
    )

    expect(removeWorktree).not.toHaveBeenCalled()
    expect(removeWorktreeLinkedPathsMock).not.toHaveBeenCalled()
    expect(deleteWorktreeHistoryDirMock).not.toHaveBeenCalled()
  })

  it('stops worktree PTYs before removing linked paths', async () => {
    const repo = { ...store.getRepos()[0], symlinkPaths: ['node_modules'] }
    const runtimeStore = { ...store, getRepos: () => [repo], getRepo: () => repo }
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    const stopAndWait = vi.fn().mockResolvedValue(true)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, 'pty-1')
    vi.mocked(removeWorktree).mockResolvedValue({})
    removeWorktreeLinkedPathsMock.mockImplementationOnce(async () => {
      // Destructive teardown must bound the underlying RPCs below the sweep deadline.
      expect(stopAndWait).toHaveBeenCalledWith(
        'pty-1',
        expect.objectContaining({ deadlineMs: expect.any(Number) })
      )
    })

    await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    expect(removeWorktreeLinkedPathsMock).toHaveBeenCalledWith(TEST_WORKTREE_PATH, ['node_modules'])
  })

  it('waits for every watcher layer to settle before restoring after teardown failure', async () => {
    const runtime = createRuntime()
    let finishRuntimeClose: () => void = () => {}
    const runtimeClose = new Promise<void>((resolve) => {
      finishRuntimeClose = resolve
    })
    const fileCommands = (
      runtime as unknown as {
        fileCommands: {
          closeFileExplorerWatchersForPath: (path: string) => Promise<void>
          restoreFileExplorerWatchersAfterFailedRemoval: (path: string) => Promise<void>
        }
      }
    ).fileCommands
    vi.spyOn(fileCommands, 'closeFileExplorerWatchersForPath').mockReturnValueOnce(runtimeClose)
    const restoreRuntime = vi
      .spyOn(fileCommands, 'restoreFileExplorerWatchersAfterFailedRemoval')
      .mockResolvedValue(undefined)
    closeLocalWatcherForWorktreePathMock.mockRejectedValueOnce(
      new Error('desktop watcher close failed')
    )

    const result = runtime.acquireFileWatcherRemoval(TEST_WORKTREE_PATH).catch((error) => error)
    await Promise.resolve()
    expect(restoreLocalWatcherAfterFailedRemovalMock).not.toHaveBeenCalled()
    expect(restoreRuntime).not.toHaveBeenCalled()

    finishRuntimeClose()
    await expect(result).resolves.toEqual(
      expect.objectContaining({
        message: 'desktop watcher close failed'
      })
    )
    expect(restoreLocalWatcherAfterFailedRemovalMock).toHaveBeenCalledWith(TEST_WORKTREE_PATH)
    expect(restoreRuntime).toHaveBeenCalledWith(TEST_WORKTREE_PATH, undefined)
  })

  it('restores runtime watchers when CLI worktree deletion fails after teardown', async () => {
    const runtime = createWorktreeRemovalRuntime()
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(removeWorktree).mockRejectedValue(new Error('delete failed'))

    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID)).rejects.toThrow('delete failed')

    expect(restoreLocalWatcherAfterFailedRemovalMock).toHaveBeenCalledWith(TEST_WORKTREE_PATH)
    expect(forgetLocalWatcherRemovalSnapshotMock).not.toHaveBeenCalled()
    const finishRetry = beginWatcherInstall(TEST_WORKTREE_PATH)
    finishRetry()
  })

  it('closes before and after draining a pre-removal watcher install', async () => {
    const runtime = createRuntime()
    const finishInstall = beginWatcherInstall(TEST_WORKTREE_PATH)

    const acquiring = runtime.acquireFileWatcherRemoval(TEST_WORKTREE_PATH)
    await vi.waitFor(() => expect(closeLocalWatcherForWorktreePathMock).toHaveBeenCalledTimes(1))
    expect(() => beginWatcherInstall(TEST_WORKTREE_PATH)).toThrow(
      'cannot start while the worktree is being removed'
    )

    finishInstall()
    const gate = await acquiring
    expect(closeLocalWatcherForWorktreePathMock).toHaveBeenCalledTimes(2)
    await gate.finish(false)
    expect(restoreLocalWatcherAfterFailedRemovalMock).toHaveBeenCalledWith(TEST_WORKTREE_PATH)

    const finishRetry = beginWatcherInstall(TEST_WORKTREE_PATH)
    finishRetry()
  })

  it('proceeds when a wedged install never releases the removal fence', async () => {
    vi.useFakeTimers()
    // Held across the whole acquire and never released — models a native subscribe that ignores abort
    // and never settles. The removal must abandon the fence slot rather than leak it into later suites.
    beginWatcherInstall(TEST_WORKTREE_PATH)
    try {
      const runtime = createRuntime()

      let acquired = false
      const acquiring = runtime.acquireFileWatcherRemoval(TEST_WORKTREE_PATH).then((gate) => {
        acquired = true
        return gate
      })
      await vi.advanceTimersByTimeAsync(WATCHER_REMOVAL_DRAIN_BUDGET_MS - 1)
      expect(acquired).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      const gate = await acquiring
      expect(acquired).toBe(true)
      expect(closeLocalWatcherForWorktreePathMock).toHaveBeenCalledTimes(2)

      // The fence must not stay armed: releasing the gate re-admits installs under this root.
      await gate.finish(true)
      const finishRetry = beginWatcherInstall(TEST_WORKTREE_PATH)
      finishRetry()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not re-spend the drain budget on a removal after a wedged install was abandoned', async () => {
    vi.useFakeTimers()
    beginWatcherInstall(TEST_WORKTREE_PATH)
    try {
      const runtime = createRuntime()

      const firstAcquiring = runtime.acquireFileWatcherRemoval(TEST_WORKTREE_PATH)
      await vi.advanceTimersByTimeAsync(WATCHER_REMOVAL_DRAIN_BUDGET_MS)
      await (await firstAcquiring).finish(true)

      let secondAcquired = false
      const secondAcquiring = runtime.acquireFileWatcherRemoval(TEST_WORKTREE_PATH).then((gate) => {
        secondAcquired = true
        return gate
      })
      await vi.advanceTimersByTimeAsync(1)

      expect(secondAcquired).toBe(true)
      await (await secondAcquiring).finish(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers forced Windows runtime long-path removal and keeps skipped-hook warnings', async () => {
    setPlatform('win32')
    const runtime = createWorktreeRemovalRuntime()
    await mkdir(TEST_WORKTREE_PATH, { recursive: true })
    await writeFile(join(TEST_WORKTREE_PATH, 'scratch.txt'), 'delete me')
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockResolvedValue({
      stdout: '',
      stderr: ''
    })
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        archive: 'pnpm worktree:archive'
      }
    })
    vi.mocked(removeWorktree).mockRejectedValue(
      Object.assign(new Error('git worktree remove failed'), {
        stderr: 'error: failed to delete deep/file.txt: Filename too long'
      })
    )
    vi.mocked(listWorktreesStrict)
      .mockResolvedValueOnce(MOCK_GIT_WORKTREES)
      .mockResolvedValueOnce(MOCK_GIT_WORKTREES)
      .mockResolvedValue([])

    try {
      const result = await runtime.removeManagedWorktree(TEST_WORKTREE_ID, true)

      expect(result).toEqual({
        preservedBranch: { branchName: 'feature/foo', head: 'abc' },
        warning: `orca.yaml archive hook skipped for ${TEST_WORKTREE_PATH}; pass --run-hooks to run it.`
      })
      expect(gitSpy).toHaveBeenCalledWith(['worktree', 'prune'], {
        cwd: TEST_REPO_PATH
      })
      if (ORIGINAL_PLATFORM === 'win32') {
        await expect(lstat(TEST_WORKTREE_PATH)).rejects.toMatchObject({ code: 'ENOENT' })
      }
      expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(TEST_WORKTREE_ID)
    } finally {
      gitSpy.mockRestore()
      await rm(TEST_WORKTREE_PATH, { recursive: true, force: true })
    }
  })

  it('refuses runtime Windows recovery while Git still reports the row and keeps metadata', async () => {
    setPlatform('win32')
    const removeWorktreeMeta = vi.fn()
    const runtimeStore = {
      ...store,
      removeWorktreeMeta
    }
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockResolvedValue({
      stdout: '',
      stderr: ''
    })
    const removePathSpy = vi
      .spyOn(localWorktreeFilesystem, 'removeLocalWorktreePath')
      .mockResolvedValue(undefined)
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(removeWorktree).mockRejectedValue(
      Object.assign(new Error('git worktree remove failed'), {
        stderr: 'error: failed to delete deep/file.txt: Filename too long'
      })
    )

    try {
      await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID, true)).rejects.toThrow(
        `Failed to force delete worktree at ${TEST_WORKTREE_PATH}. error: failed to delete deep/file.txt: Filename too long`
      )
      expect(removePathSpy).not.toHaveBeenCalled()
      expect(gitSpy).not.toHaveBeenCalledWith(['worktree', 'prune'], expect.anything())
      expect(removeWorktreeMeta).not.toHaveBeenCalled()
    } finally {
      removePathSpy.mockRestore()
      gitSpy.mockRestore()
    }
  })

  it('retries stale runtime Git registration cleanup after prior filesystem recovery', async () => {
    setPlatform('win32')
    const missingWorktreePath = 'C:\\workspace\\already-removed'
    const worktreeId = `${TEST_REPO_ID}::${missingWorktreePath}`
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(worktreeId)
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    const registeredWorktrees = [
      {
        path: TEST_REPO_PATH,
        head: 'main',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: missingWorktreePath,
        head: 'abc',
        branch: 'refs/heads/feature/foo',
        isBare: false,
        isMainWorktree: false
      }
    ]
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockResolvedValue({
      stdout: '',
      stderr: ''
    })
    vi.mocked(listWorktrees).mockResolvedValue(registeredWorktrees)
    vi.mocked(listWorktreesStrict).mockResolvedValueOnce(registeredWorktrees).mockResolvedValue([])
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        archive: 'pnpm worktree:archive'
      }
    })

    try {
      const result = await runtime.removeManagedWorktree(worktreeId, true)

      expect(result).toEqual({
        preservedBranch: { branchName: 'feature/foo', head: 'abc' }
      })
      expect(runHook).not.toHaveBeenCalled()
      expect(removeWorktree).not.toHaveBeenCalled()
      expect(gitSpy).toHaveBeenCalledWith(['worktree', 'prune'], {
        cwd: TEST_REPO_PATH
      })
      // The repo resolved to the local host, so the metadata purge names it —
      // an unqualified purge would evict a same-id row owned by another host.
      expect(removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'local')
    } finally {
      gitSpy.mockRestore()
    }
  })

  it('preserves a locked missing runtime registration even with force', async () => {
    setPlatform('win32')
    const missingWorktreePath = 'C:\\workspace\\locked-already-removed'
    const worktreeId = `${TEST_REPO_ID}::${missingWorktreePath}`
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(worktreeId)
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    const registeredWorktrees = [
      {
        path: missingWorktreePath,
        head: 'abc',
        branch: 'refs/heads/feature/foo',
        isBare: false,
        isMainWorktree: false,
        locked: true,
        lockReason: 'active agent session'
      }
    ]
    vi.mocked(listWorktreesStrict).mockResolvedValue(registeredWorktrees)
    vi.mocked(removeWorktree).mockResolvedValue({})

    await expect(runtime.removeManagedWorktree(worktreeId, true, false)).rejects.toThrow(
      'Worktree is locked by Git. Lock reason: active agent session'
    )

    expect(removeWorktree).not.toHaveBeenCalled()
    expect(removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('routes runtime worktree removal through the selected WSL project runtime', async () => {
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
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(removeWorktree).mockResolvedValue({})

    await runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    expect(assertWorktreeCleanForRemoval).toHaveBeenCalledWith(TEST_WORKTREE_PATH, false, {
      wslDistro: 'Ubuntu'
    })
    expect(removeWorktree).toHaveBeenCalledWith(TEST_REPO_PATH, TEST_WORKTREE_PATH, false, {
      knownRemovedWorktree: expect.objectContaining({ path: TEST_WORKTREE_PATH }),
      wslDistro: 'Ubuntu'
    })
  })

  it('deletes a Windows runtime worktree using the canonical registered path', async () => {
    setPlatform('win32')
    const repo = {
      id: TEST_REPO_ID,
      path: 'C:\\repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1
    }
    const requestedWorktreeId = `${TEST_REPO_ID}::C:/workspaces/improve-dashboard`
    const registeredWorktree = {
      path: 'c:\\workspaces\\Improve-Dashboard',
      head: 'feature-head',
      branch: 'refs/heads/improve-dashboard',
      isBare: false,
      isMainWorktree: false
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [repo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? repo : undefined),
      getAllWorktreeMeta: () => ({
        [requestedWorktreeId]: makeWorktreeMeta()
      }),
      getWorktreeMeta: (worktreeId: string) =>
        worktreeId === requestedWorktreeId ? makeWorktreeMeta() : undefined,
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
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: repo.path,
        head: 'main-head',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      registeredWorktree
    ])
    vi.mocked(listWorktreesStrict).mockResolvedValue([
      {
        path: repo.path,
        head: 'main-head',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      registeredWorktree
    ])
    vi.mocked(removeWorktree).mockResolvedValue({})

    await runtime.removeManagedWorktree(requestedWorktreeId)

    expect(listWorktrees).toHaveBeenCalledWith(repo.path, { wslDistro: 'Ubuntu' })
    expect(listWorktreesStrict).toHaveBeenCalledWith(repo.path, { wslDistro: 'Ubuntu' })
    expect(assertWorktreeCleanForRemoval).toHaveBeenCalledWith(registeredWorktree.path, false, {
      wslDistro: 'Ubuntu'
    })
    expect(removeWorktree).toHaveBeenCalledWith(repo.path, registeredWorktree.path, false, {
      knownRemovedWorktree: registeredWorktree,
      wslDistro: 'Ubuntu'
    })
  })

  it('surfaces selected-runtime list failures during runtime worktree removal', async () => {
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
    vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
    vi.mocked(listWorktreesStrict).mockRejectedValue(new Error('wsl git list failed'))

    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID)).rejects.toThrow(
      'wsl git list failed'
    )

    expect(listWorktrees).toHaveBeenCalledWith(TEST_REPO_PATH, { wslDistro: 'Ubuntu' })
    expect(listWorktreesStrict).toHaveBeenCalledWith(TEST_REPO_PATH, { wslDistro: 'Ubuntu' })
    expect(assertWorktreeCleanForRemoval).not.toHaveBeenCalled()
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('force-deletes a branch that was preserved by runtime worktree removal', async () => {
    const runtime = createWorktreeRemovalRuntime()
    vi.mocked(removeWorktree).mockResolvedValue({
      preservedBranch: { branchName: 'feature/test', head: 'def456' }
    })

    await runtime.removeManagedWorktree(TEST_WORKTREE_ID)
    const result = await runtime.forceDeletePreservedBranch(
      TEST_WORKTREE_ID,
      'feature/test',
      'def456'
    )

    expect(result).toEqual({ deleted: true })
    expect(forceDeleteLocalBranchMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'feature/test',
      'def456'
    )
  })

  it('force-deletes an SSH branch that was preserved by runtime worktree removal', async () => {
    const remoteRepo = {
      ...store.getRepo(TEST_REPO_ID)!,
      path: '/remote/repo',
      connectionId: 'ssh-1'
    }
    const remoteWorktree = {
      path: '/remote/feature-wt',
      head: 'def456',
      branch: 'feature/test',
      isBare: false,
      isMainWorktree: false
    }
    const remoteWorktreeId = `${remoteRepo.id}::${remoteWorktree.path}`
    const metaById: Record<string, WorktreeMeta> = {
      [remoteWorktreeId]: makeWorktreeMeta()
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      removeWorktreeMeta: (worktreeId: string) => {
        delete metaById[worktreeId]
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
      await runtime.removeManagedWorktree(remoteWorktreeId)
      const result = await runtime.forceDeletePreservedBranch(
        remoteWorktreeId,
        'feature/test',
        'def456'
      )

      expect(result).toEqual({ deleted: true })
      expect(provider.forceDeletePreservedBranch).toHaveBeenCalledWith(
        '/remote/repo',
        'feature/test',
        'def456'
      )
      expect(forceDeleteLocalBranchMock).not.toHaveBeenCalled()
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })
})
