import * as gitExecFile from '../../git/command-runner/git-exec-file'
import { describe, expect, it, vi, type MockInstance } from 'vitest'
import { readFile, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { _settlePendingWorktreeRemovalsForTests } from '../../workspaces/removal/worktree-background-removal'

import './runtime-test-module-registration.spec'
import { assertWorktreeCleanForRemoval } from '../../git/worktrees/removal/worktree-removal-preflight'
import {
  closeLocalWatcherForWorktreePathMock,
  deleteWorktreeHistoryDirMock,
  forceDeleteLocalBranchMock,
  invalidateAuthorizedRootsCacheMock
} from '../orca-runtime-test-mocks/setup.spec'
import { join } from 'node:path'
import { listWorktrees } from '../../git/worktrees/catalog/worktree-scan-cache'

import { removeWorktree } from '../../git/worktrees/removal/worktree-removal'
import { runHook } from '../../workspace-hooks/hooks'
import { tmpdir } from 'node:os'
import {
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  createStaleRuntimeWorktreeStore,
  deferred,
  store
} from './orca-runtime-test-fixtures.spec'
import { createWorktreeRemovalRuntime } from './orca-runtime-test-scenario-builders.spec'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'

// Connected SSH fixtures need the host HOME for removal guards.

describe('OrcaRuntimeService', () => {
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
    // Migrated executionHostId must keep remote removal separate from the same-path local owner.
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

    const remoteRefusal = expect(remote).rejects.toThrow('selector_not_found')
    await localStarted.promise
    await remoteRefusal

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
    // Acceptance follows every refusal; a force retry has nothing left to waive.
    const second = runtime.removeManagedWorktree(TEST_WORKTREE_ID, { force: true })
    await vi.waitFor(() => expect(resolveTarget).toHaveBeenCalledTimes(2))
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
    const gitSpy = vi.spyOn(gitExecFile, 'gitExecFileAsync').mockImplementation(async (args) => {
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
