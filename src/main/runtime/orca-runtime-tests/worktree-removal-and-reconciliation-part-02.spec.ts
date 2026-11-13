import type * as WorktreeRemovalModule from '../../git/worktrees/removal/worktree-removal'
import * as gitExecFile from '../../git/command-runner/git-exec-file'
import { describe, expect, it, vi } from 'vitest'
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises'
const { removeWorktree: removeNativeWorktree } = await vi.importActual<
  typeof WorktreeRemovalModule
>('../../git/worktrees/removal/worktree-removal')

import './runtime-test-module-registration.spec'
import {
  MOCK_GIT_WORKTREES,
  closeLocalWatcherForWorktreePathMock,
  deleteWorktreeHistoryDirMock,
  forgetLocalWatcherRemovalSnapshotMock,
  removeWorktreeLinkedPathsMock,
  restoreLocalWatcherAfterFailedRemovalMock,
  setPlatform
} from '../orca-runtime-test-mocks/setup.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { WATCHER_REMOVAL_DRAIN_BUDGET_MS } from '../../workspaces/removal/watcher-removal-drain'
import { assertWorktreeCleanForRemoval } from '../../git/worktrees/removal/worktree-removal-preflight'
import { beginWatcherInstall } from '../../workspaces/removal/watcher-removal-gate'
import { getEffectiveHooks, runHook } from '../../workspace-hooks/hooks'
import { join } from 'node:path'
import { listWorktrees } from '../../git/worktrees/catalog/worktree-scan-cache'
import { listWorktreesStrict } from '../../git/worktrees/catalog/worktree-listing'
import * as localWorktreeFilesystem from '../../workspaces/removal/local-worktree-filesystem'

import { removeWorktree } from '../../git/worktrees/removal/worktree-removal'
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
} from './orca-runtime-test-fixtures.spec'
import { createWorktreeRemovalRuntime } from './orca-runtime-test-scenario-builders.spec'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'

// Connected SSH fixtures need the host HOME for removal guards.

describe('OrcaRuntimeService', () => {
  it('never sweeps an orphaned SSH worktree through the local provider', async () => {
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
    const runtime = new OrcaRuntimeService(orphanStore as never, undefined, {
      getLocalProvider: () => localProvider as never
    })

    await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID)).resolves.toEqual({
      warning: expect.stringContaining(TEST_WORKTREE_PATH)
    })

    expect(localProvider.listProcesses).not.toHaveBeenCalled()
    expect(closeLocalWatcherForWorktreePathMock).not.toHaveBeenCalled()
    expect(restoreLocalWatcherAfterFailedRemovalMock).not.toHaveBeenCalled()
    expect(forgetLocalWatcherRemovalSnapshotMock).not.toHaveBeenCalled()
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
    // Model an unabortable native subscribe; removal must abandon its fence slot instead of leaking it.
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

      await gate.finish(true)
      const finishRetry = beginWatcherInstall(TEST_WORKTREE_PATH)
      finishRetry()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a nonempty markerless Windows folder before teardown and keeps skipped-hook warnings', async () => {
    setPlatform('win32')
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(TEST_WORKTREE_ID)
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    deleteWorktreeHistoryDirMock.mockClear()
    const teardown = vi.spyOn(runtime, 'acquireFileWatcherRemoval')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await mkdir(TEST_WORKTREE_PATH, { recursive: true })
    await writeFile(join(TEST_WORKTREE_PATH, 'scratch.txt'), 'delete me')
    const gitSpy = vi.spyOn(gitExecFile, 'gitExecFileAsync').mockResolvedValue({
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
      await expect(
        runtime.removeManagedWorktree(TEST_WORKTREE_ID, { force: true })
      ).rejects.toThrow('is no longer a Git worktree, so its folder was left on disk.')
      expect(warning).toHaveBeenCalledWith(
        `[hooks] orca.yaml archive hook skipped for ${TEST_WORKTREE_PATH}; pass --run-hooks to run it.`
      )
      expect(teardown).not.toHaveBeenCalled()
      expect(runHook).not.toHaveBeenCalled()
      expect(removeWorktree).not.toHaveBeenCalled()
      expect(removeWorktreeMeta).not.toHaveBeenCalled()
      expect(deleteWorktreeHistoryDirMock).not.toHaveBeenCalled()
      expect(closeLocalWatcherForWorktreePathMock).not.toHaveBeenCalled()
      expect(gitSpy).not.toHaveBeenCalledWith(['worktree', 'prune'], expect.anything())
      expect(await readFile(join(TEST_WORKTREE_PATH, 'scratch.txt'), 'utf8')).toBe('delete me')
      expect(runtimeStore.getWorktreeMeta(TEST_WORKTREE_ID)).toBeDefined()
    } finally {
      warning.mockRestore()
      teardown.mockRestore()
      gitSpy.mockRestore()
      await rm(TEST_WORKTREE_PATH, { recursive: true, force: true })
    }
  })

  it('passes through native Windows removal failures without recursive recovery or metadata cleanup', async () => {
    setPlatform('win32')
    const removeWorktreeMeta = vi.fn()
    const runtimeStore = {
      ...store,
      removeWorktreeMeta
    }
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    const gitSpy = vi.spyOn(gitExecFile, 'gitExecFileAsync').mockResolvedValue({
      stdout: '',
      stderr: ''
    })
    const prepareFilesystem = localWorktreeFilesystem.prepareLocalWorktreeFilesystem
    const removePathSpy = vi.fn().mockResolvedValue(undefined)
    const preparePathSpy = vi
      .spyOn(localWorktreeFilesystem, 'prepareLocalWorktreeFilesystem')
      .mockImplementation(async (...args) => ({
        ...(await prepareFilesystem(...args)),
        remove: removePathSpy
      }))
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    const path = join(TEST_WORKTREE_PATH, 'deep', 'file.txt')
    const cause = Object.assign(new Error('permission denied'), { code: 'EACCES', path })
    const failure = Object.assign(
      new Error(
        `${path} could not be deleted; it may be read-only or open in another program. Close any program using it and delete again.`,
        { cause }
      ),
      { code: 'EACCES', path }
    )
    vi.mocked(removeWorktree).mockRejectedValue(failure)

    try {
      await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID, { force: true })).rejects.toBe(
        failure
      )
      expect(removePathSpy).not.toHaveBeenCalled()
      expect(gitSpy).not.toHaveBeenCalledWith(['worktree', 'prune'], expect.anything())
      expect(removeWorktreeMeta).not.toHaveBeenCalled()
    } finally {
      preparePathSpy.mockRestore()
      gitSpy.mockRestore()
    }
  })

  it('releases only the missing native checkout registration and preserves its branch and host metadata policy', async () => {
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
    const gitSpy = vi.spyOn(gitExecFile, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'branch') {
        throw new Error('branch is not fully merged')
      }
      return {
        stdout:
          args[0] === 'worktree' && args[1] === 'list'
            ? registeredWorktrees
                .map((row) => `worktree ${row.path}\0HEAD ${row.head}\0branch ${row.branch}\0\0`)
                .join('')
            : '',
        stderr: ''
      }
    })
    vi.mocked(removeWorktree).mockImplementation(removeNativeWorktree)
    vi.mocked(listWorktrees).mockResolvedValue(registeredWorktrees)
    vi.mocked(listWorktreesStrict).mockResolvedValue(registeredWorktrees)
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        archive: 'pnpm worktree:archive'
      }
    })

    try {
      const result = await runtime.removeManagedWorktree(worktreeId, { force: true })

      expect(result).toEqual({
        preservedBranch: { branchName: 'feature/foo', head: 'abc' },
        warning: `orca.yaml archive hook skipped for ${missingWorktreePath}; pass --run-hooks to run it.`
      })
      expect(runHook).not.toHaveBeenCalled()
      expect(removeWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        missingWorktreePath,
        true,
        expect.objectContaining({ knownRemovedWorktree: registeredWorktrees[1] })
      )
      expect(gitSpy).toHaveBeenCalledWith(
        ['-c', 'core.longpaths=true', 'worktree', 'remove', '--force', '--', missingWorktreePath],
        expect.objectContaining({ cwd: TEST_REPO_PATH, admissionExempt: true })
      )
      expect(gitSpy).not.toHaveBeenCalledWith(['worktree', 'prune'], expect.anything())
      // Host-qualified metadata purge preserves same-id rows on other hosts.
      expect(removeWorktreeMeta).toHaveBeenCalledWith(
        hostWorktreeTarget({ id: worktreeId, hostId: 'local' })
      )
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

    await expect(
      runtime.removeManagedWorktree(worktreeId, { force: true, runHooks: false })
    ).rejects.toThrow('Worktree is locked by Git. Lock reason: active agent session')

    expect(removeWorktree).not.toHaveBeenCalled()
    expect(removeWorktreeMeta).not.toHaveBeenCalled()
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
})
