import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTree } from '../../../../shared/windows-transient-lock-removal'

const { gitExecFileAsyncMock, gitExecFileSyncMock, translateWslOutputPathsMock } = vi.hoisted(
  () => ({
    gitExecFileAsyncMock: vi.fn(),
    gitExecFileSyncMock: vi.fn(),
    translateWslOutputPathsMock: vi.fn((output: string) => output)
  })
)

vi.mock('../../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../../command-runner/git-exec-file-sync', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileSync: gitExecFileSyncMock
}))

vi.mock('../../command-runner/host-routing/wsl-path-translation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  translateWslOutputPaths: translateWslOutputPathsMock
}))

import { addWorktree } from './worktree-add'
import { registerWorktreeSuiteHooks } from '../testing/worktree-test-harness'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  loadWorktreeRemovalRecords,
  startBackgroundWorktreeRemoval,
  stopBackgroundWorktreeRemovals,
  waitForWorktreeRemovalAcceptance
} from '../../../workspaces/removal/worktree-background-removal'

registerWorktreeSuiteHooks()

async function startDeleting(): Promise<void> {
  void startBackgroundWorktreeRemoval({
    removal: {
      worktreeId: 'repo-1::/repo-feature',
      repoId: 'repo-1',
      repoPath: '/repo',
      worktree: { path: '/repo-feature', branch: 'refs/heads/feature/test', head: 'abc' },
      deleteBranch: true,
      force: false
    },
    run: (signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({}))),
    publish: () => {}
  })
  await waitForWorktreeRemovalAcceptance('repo-1::/repo-feature')
}

describe('addWorktree while Orca deletes a checkout in the background', () => {
  let directory = ''
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-add-pending-removal-'))
    await loadWorktreeRemovalRecords(directory)
  })
  afterEach(async () => {
    stopBackgroundWorktreeRemovals()
    await _settlePendingWorktreeRemovalsForTests()
    _resetPendingWorktreeRemovalsForTests()
    await removeTree(directory)
  })

  it('refuses the same path with a clear message and runs no git', async () => {
    await startDeleting()
    await expect(addWorktree('/repo', '/repo-feature', 'other-branch')).rejects.toThrow(
      'Orca is still deleting the workspace at /repo-feature. Cleanup is pending; try again shortly.'
    )
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('refuses the same branch, which the delete removes when it finishes', async () => {
    await startDeleting()
    await expect(
      addWorktree('/repo', '/repo-elsewhere', 'feature/test', undefined, false, false, {
        checkoutExistingBranch: true
      })
    ).rejects.toThrow('Cleanup is pending; try again shortly.')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
