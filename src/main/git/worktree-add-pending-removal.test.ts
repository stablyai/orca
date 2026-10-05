import { afterEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, gitExecFileSyncMock, translateWslOutputPathsMock } = vi.hoisted(
  () => ({
    gitExecFileAsyncMock: vi.fn(),
    gitExecFileSyncMock: vi.fn(),
    translateWslOutputPathsMock: vi.fn((output: string) => output)
  })
)

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

import { addWorktree } from './worktree'
import { registerWorktreeSuiteHooks } from './worktree-test-harness'
import {
  _resetPendingWorktreeRemovalsForTests,
  startBackgroundWorktreeRemoval
} from '../worktree-background-removal'

registerWorktreeSuiteHooks()

function startDeleting(): void {
  void startBackgroundWorktreeRemoval({
    removal: {
      worktreeId: 'repo-1::/repo-feature',
      repoId: 'repo-1',
      repoPath: '/repo',
      worktree: { path: '/repo-feature', branch: 'refs/heads/feature/test', head: 'abc' },
      deleteBranch: true,
      force: false
    },
    run: () => new Promise(() => {}),
    publish: () => {}
  })
}

describe('addWorktree while Orca deletes a checkout in the background', () => {
  afterEach(() => {
    _resetPendingWorktreeRemovalsForTests()
  })

  it('refuses the same path with a clear message and runs no git', async () => {
    startDeleting()
    await expect(addWorktree('/repo', '/repo-feature', 'other-branch')).rejects.toThrow(
      'Orca is still deleting the workspace at /repo-feature. Cleanup is pending; try again shortly.'
    )
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('refuses the same branch, which the delete removes when it finishes', async () => {
    startDeleting()
    await expect(
      addWorktree('/repo', '/repo-elsewhere', 'feature/test', undefined, false, false, {
        checkoutExistingBranch: true
      })
    ).rejects.toThrow('Cleanup is pending; try again shortly.')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
