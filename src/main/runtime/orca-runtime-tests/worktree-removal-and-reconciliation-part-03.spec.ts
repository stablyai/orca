import { describe, expect, it, vi, type MockInstance } from 'vitest'
import { readFile } from 'node:fs/promises'
import { _settlePendingWorktreeRemovalsForTests } from '../../worktree-background-removal'

import {
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
  removeWorktree,
  rm,
  runHook,
  setPlatform,
  tmpdir,
  writeFile
} from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_REPO_PATH,
  TEST_WORKTREE_ID,
  createStaleRuntimeWorktreeStore,
  deferred,
  store
} from '../orca-runtime-test-fixtures.spec'
import { createWorktreeRemovalRuntime } from '../orca-runtime-test-scenario-builders.spec'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'

// Why: these fixtures register an SSH provider, which models a connected relay session — and a
// connected session has always read the host's `$HOME`. The removal guards refuse without it.

describe('OrcaRuntimeService', () => {
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

    const first = runtime.removeManagedWorktree(TEST_WORKTREE_ID, { force: true })
    const second = runtime.removeManagedWorktree(TEST_WORKTREE_ID, { force: true })

    await removeStarted.promise
    await Promise.resolve()
    expect(removeWorktree).toHaveBeenCalledTimes(1)

    finishRemoval.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([{}, {}])
  })

  it('does not coalesce concurrent same-id removals on different hosts', async () => {
    const baseRepo = store.getRepos()[0]!
    // The second owner names its host only in the migrated spelling, so its removal must reach the
    // SSH host rather than joining the local one and running `git worktree remove` here.
    const remoteRepo = { ...baseRepo, path: '/remote/repo', executionHostId: 'ssh:host-b' }
    const runtimeStore = {
      ...store,
      getRepos: () => [{ ...baseRepo, executionHostId: 'local' }, remoteRepo]
    }
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    vi.spyOn(runtime, 'acquireFileWatcherRemoval').mockResolvedValue({ finish: vi.fn() })
    const localStarted = deferred<void>()
    const finishRemovals = deferred<void>()
    const startRemoval = async (): Promise<Record<string, never>> => {
      localStarted.resolve()
      await finishRemovals.promise
      return {}
    }
    vi.mocked(removeWorktree).mockImplementation(startRemoval)
    const local = runtime.removeManagedWorktree(TEST_WORKTREE_ID, {
      force: true,
      runHooks: false,
      allowUnverifiedPtyStop: false,
      hostId: 'local'
    })
    const remote = runtime.removeManagedWorktree(TEST_WORKTREE_ID, {
      force: true,
      runHooks: false,
      allowUnverifiedPtyStop: false,
      hostId: 'ssh:host-b'
    })

    await localStarted.promise
    // Joining the local removal would have resolved; the unserved host's catalog refuses instead.
    await expect(remote).rejects.toThrow('selector_not_found')

    finishRemovals.resolve()
    await expect(local).resolves.toEqual({})
    expect(removeWorktree).toHaveBeenCalledTimes(1)
  })

  it('joins a runtime removal Git is already deleting, even with different options', async () => {
    const runtime = createWorktreeRemovalRuntime()
    const removeStarted = deferred<void>()
    const finishRemoval = deferred<void>()
    vi.mocked(removeWorktree).mockImplementation(async () => {
      removeStarted.resolve()
      await finishRemoval.promise
      return {}
    })

    const resolveTarget: MockInstance<(...args: unknown[]) => Promise<unknown>> = vi.spyOn(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveWorktreeRemovalTarget is a protected runtime method the spy only observes.
      runtime as never,
      'resolveWorktreeRemovalTarget'
    )
    const first = runtime.removeManagedWorktree(TEST_WORKTREE_ID)

    await removeStarted.promise
    // Accepted means every refusal already ran; a Force Delete retry has nothing left to waive.
    const second = runtime.removeManagedWorktree(TEST_WORKTREE_ID, { force: true })
    await vi.waitFor(() => expect(resolveTarget).toHaveBeenCalledTimes(2))
    // The retry checks the removal table right after this resolves, before Git is let finish.
    await resolveTarget.mock.results[1]?.value
    finishRemoval.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([{}, {}])
    expect(removeWorktree).toHaveBeenCalledTimes(1)
  })

  it('answers a client that cannot wait as soon as Git starts deleting', async () => {
    const runtime = createWorktreeRemovalRuntime()
    const removeStarted = deferred<void>()
    const finishRemoval = deferred<void>()
    vi.mocked(removeWorktree).mockImplementation(async () => {
      removeStarted.resolve()
      await finishRemoval.promise
      return {}
    })

    const accepted = runtime.removeManagedWorktree(TEST_WORKTREE_ID, {
      waitForBackgroundRemoval: false
    })
    await removeStarted.promise
    await expect(accepted).resolves.toEqual({ removing: true })
    finishRemoval.resolve()
    await _settlePendingWorktreeRemovalsForTests()
  })

  it('replies to a waiting client with the error of a delete that fails after acceptance', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = createWorktreeRemovalRuntime()
    vi.mocked(removeWorktree).mockRejectedValue(new Error('permission denied'))

    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID)).rejects.toThrow(
      'permission denied'
    )
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

      await expect(runtime.removeManagedWorktree(worktreeId, { force: true })).resolves.toEqual({})

      expect(removeWorktree).not.toHaveBeenCalled()
      // The repo resolved to the local host, so the metadata purge names it —
      // an unqualified purge would evict a same-id row owned by another host.
      expect(removeWorktreeMeta).toHaveBeenCalledWith(
        hostWorktreeTarget({ id: worktreeId, hostId: 'local' })
      )
      expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
      expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalledWith(runtimeStore, TEST_REPO_ID)
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
      expect(removeWorktreeMeta).toHaveBeenCalledWith(
        hostWorktreeTarget({ id: worktreeId, hostId: 'local' })
      )
      expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
      expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalledWith(runtimeStore, TEST_REPO_ID)
      expect(notifier.worktreesChanged).toHaveBeenCalledWith(TEST_REPO_ID)
    } finally {
      await rm(parentDir, { recursive: true, force: true })
    }
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

      await expect(runtime.removeManagedWorktree(worktreeId, { force: true })).resolves.toEqual({})

      await expect(lstat(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(closeLocalWatcherForWorktreePathMock).toHaveBeenCalledWith(
        orphanPath,
        expect.objectContaining({ remainingMs: expect.any(Function) })
      )
      expect(removeWorktree).not.toHaveBeenCalled()
      // The repo resolved to the local host, so the metadata purge names it —
      // an unqualified purge would evict a same-id row owned by another host.
      expect(removeWorktreeMeta).toHaveBeenCalledWith(
        hostWorktreeTarget({ id: worktreeId, hostId: 'local' })
      )
      expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
      expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
      expect(notifier.worktreesChanged).toHaveBeenCalledWith(TEST_REPO_ID)
    } finally {
      // Why: Windows can keep a just-inspected git admin dir busy briefly.
      await rm(parentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('refuses an Orca-created runtime unregistered directory with no git marker, even forced, until the user removes it', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'orca-runtime-leftover-'))
    const repoPath = join(parentDir, 'repo')
    const leftoverPath = join(parentDir, 'leftover')
    const worktreeId = `${TEST_REPO_ID}::${leftoverPath}`
    await mkdir(leftoverPath, { recursive: true })
    await writeFile(join(leftoverPath, 'notes.txt'), 'mine\n')
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

      for (const force of [false, true]) {
        await expect(runtime.removeManagedWorktree(worktreeId, { force })).rejects.toThrow(
          `Refusing to delete unregistered worktree path: ${leftoverPath}`
        )
      }
      await expect(readFile(join(leftoverPath, 'notes.txt'), 'utf8')).resolves.toBe('mine\n')
      expect(removeWorktree).not.toHaveBeenCalled()
      expect(removeWorktreeMeta).not.toHaveBeenCalled()

      await rm(leftoverPath, { recursive: true, force: true })
      await expect(runtime.removeManagedWorktree(worktreeId)).resolves.toEqual({})

      expect(assertWorktreeCleanForRemoval).not.toHaveBeenCalled()
      expect(runHook).not.toHaveBeenCalled()
      expect(removeWorktree).not.toHaveBeenCalled()
      // The repo resolved to the local host, so the metadata purge names it —
      // an unqualified purge would evict a same-id row owned by another host.
      expect(removeWorktreeMeta).toHaveBeenCalledWith(
        hostWorktreeTarget({ id: worktreeId, hostId: 'local' })
      )
      expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
      expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
      expect(notifier.worktreesChanged).toHaveBeenCalledWith(TEST_REPO_ID)
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

      await expect(runtime.removeManagedWorktree(worktreeId, { force: true })).rejects.toThrow(
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
