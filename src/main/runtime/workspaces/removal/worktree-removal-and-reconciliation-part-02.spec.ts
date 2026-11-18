import * as gitExecFile from '../../../git/command-runner/git-exec-file'
import { describe, expect, it, vi } from 'vitest'
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises'

import '../../construction/test-context/runtime-test-module-registration.spec'
import {
  MOCK_GIT_WORKTREES,
  closeLocalWatcherForWorktreePathMock,
  deleteWorktreeHistoryDirMock,
  setPlatform
} from '../../orca-runtime-test-mocks/setup.spec'
import '../../../workspaces/removal/watcher-removal-drain'
import '../../../workspaces/removal/watcher-removal-gate'
import { join } from 'node:path'
import { listWorktreesStrict } from '../../../git/worktrees/catalog/worktree-listing'

import { removeWorktree } from '../../../git/worktrees/removal/worktree-removal'
import {
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  createStaleRuntimeWorktreeStore
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'
import { createWorktreeRemovalRuntime } from '../../construction/test-context/orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
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
