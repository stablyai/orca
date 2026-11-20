import * as gitExecFile from '../../../git/command-runner/git-exec-file'
import { describe, expect, it, vi } from 'vitest'
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

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
  TEST_REPO_ID,
  createStaleRuntimeWorktreeStore
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'
import { createWorktreeRemovalRuntime } from '../../construction/test-context/orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  it('refuses a nonempty markerless Windows folder before teardown', async () => {
    setPlatform('win32')
    const ownedRoot = await mkdtemp(join(tmpdir(), 'orca-markerless-windows-'))
    const worktreePath = join(ownedRoot, 'worktree-a')
    const worktreeId = `${TEST_REPO_ID}::${worktreePath}`
    const listedWorktrees = MOCK_GIT_WORKTREES.map((worktree) => ({
      ...worktree,
      path: worktreePath
    }))
    const { runtimeStore, removeWorktreeMeta } = createStaleRuntimeWorktreeStore(worktreeId)
    const runtime = createWorktreeRemovalRuntime(runtimeStore)
    deleteWorktreeHistoryDirMock.mockClear()
    const teardown = vi.spyOn(runtime, 'acquireFileWatcherRemoval')
    await mkdir(worktreePath)
    await writeFile(join(worktreePath, 'scratch.txt'), 'delete me')
    const gitSpy = vi.spyOn(gitExecFile, 'gitExecFileAsync').mockResolvedValue({
      stdout: '',
      stderr: ''
    })
    vi.mocked(listWorktreesStrict)
      .mockResolvedValueOnce(listedWorktrees)
      .mockResolvedValueOnce(listedWorktrees)
      .mockResolvedValue([])

    try {
      await expect(runtime.removeManagedWorktree(worktreeId, { force: true })).rejects.toThrow(
        'is no longer a Git worktree, so its folder was left on disk.'
      )
      expect(teardown).not.toHaveBeenCalled()
      expect(removeWorktree).not.toHaveBeenCalled()
      expect(removeWorktreeMeta).not.toHaveBeenCalled()
      expect(deleteWorktreeHistoryDirMock).not.toHaveBeenCalled()
      expect(closeLocalWatcherForWorktreePathMock).not.toHaveBeenCalled()
      expect(await readFile(join(worktreePath, 'scratch.txt'), 'utf8')).toBe('delete me')
      expect(runtimeStore.getWorktreeMeta(worktreeId)).toBeDefined()
    } finally {
      teardown.mockRestore()
      gitSpy.mockRestore()
      await rm(ownedRoot, { recursive: true, force: true })
    }
  })
})
