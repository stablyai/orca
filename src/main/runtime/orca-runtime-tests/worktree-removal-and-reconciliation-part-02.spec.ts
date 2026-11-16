import * as gitExecFile from '../../git/command-runner/git-exec-file'
import { describe, expect, it, vi } from 'vitest'
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises'

import './runtime-test-module-registration.spec'
import {
  MOCK_GIT_WORKTREES,
  closeLocalWatcherForWorktreePathMock,
  deleteWorktreeHistoryDirMock,
  restoreLocalWatcherAfterFailedRemovalMock,
  setPlatform
} from '../orca-runtime-test-mocks/setup.spec'
import { WATCHER_REMOVAL_DRAIN_BUDGET_MS } from '../../workspaces/removal/watcher-removal-drain'
import { beginWatcherInstall } from '../../workspaces/removal/watcher-removal-gate'
import { join } from 'node:path'
import { listWorktreesStrict } from '../../git/worktrees/catalog/worktree-listing'

import { removeWorktree } from '../../git/worktrees/removal/worktree-removal'
import {
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  createRuntime,
  createStaleRuntimeWorktreeStore
} from './orca-runtime-test-fixtures.spec'
import { createWorktreeRemovalRuntime } from './orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  it('blocks new watcher installs while a pre-removal install drains', async () => {
    const runtime = createRuntime()
    const finishInstall = beginWatcherInstall(TEST_WORKTREE_PATH)

    const acquiring = runtime.acquireFileWatcherRemoval(TEST_WORKTREE_PATH)
    await vi.waitFor(() => expect(closeLocalWatcherForWorktreePathMock).toHaveBeenCalled())
    expect(() => beginWatcherInstall(TEST_WORKTREE_PATH)).toThrow(
      'cannot start while the worktree is being removed'
    )

    finishInstall()
    const gate = await acquiring
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

      await gate.finish(true)
      const finishRetry = beginWatcherInstall(TEST_WORKTREE_PATH)
      finishRetry()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a nonempty markerless Windows folder before teardown', async () => {
    setPlatform('win32')
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(TEST_WORKTREE_ID)
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    deleteWorktreeHistoryDirMock.mockClear()
    const teardown = vi.spyOn(runtime, 'acquireFileWatcherRemoval')
    await mkdir(TEST_WORKTREE_PATH, { recursive: true })
    await writeFile(join(TEST_WORKTREE_PATH, 'scratch.txt'), 'delete me')
    const gitSpy = vi.spyOn(gitExecFile, 'gitExecFileAsync').mockResolvedValue({
      stdout: '',
      stderr: ''
    })
    vi.mocked(listWorktreesStrict)
      .mockResolvedValueOnce(MOCK_GIT_WORKTREES)
      .mockResolvedValueOnce(MOCK_GIT_WORKTREES)
      .mockResolvedValue([])

    try {
      await expect(
        runtime.removeManagedWorktree(TEST_WORKTREE_ID, { force: true })
      ).rejects.toThrow('is no longer a Git worktree, so its folder was left on disk.')
      expect(teardown).not.toHaveBeenCalled()
      expect(removeWorktree).not.toHaveBeenCalled()
      expect(removeWorktreeMeta).not.toHaveBeenCalled()
      expect(deleteWorktreeHistoryDirMock).not.toHaveBeenCalled()
      expect(closeLocalWatcherForWorktreePathMock).not.toHaveBeenCalled()
      expect(await readFile(join(TEST_WORKTREE_PATH, 'scratch.txt'), 'utf8')).toBe('delete me')
      expect(runtimeStore.getWorktreeMeta(TEST_WORKTREE_ID)).toBeDefined()
    } finally {
      teardown.mockRestore()
      gitSpy.mockRestore()
      await rm(TEST_WORKTREE_PATH, { recursive: true, force: true })
    }
  })
})
