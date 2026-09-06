import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handlers,
  store,
  REPO_PATH,
  WORKTREE_FEATURE_PATH,
  detectConflictOperationMock,
  resetFilesystemIpcMocks
} from './filesystem-test-harness'

const getLocalGitOptionsForRegisteredWorktreeMock = vi.hoisted(() => vi.fn())

vi.mock('electron', async () => (await import('./filesystem-test-harness')).electronMock)
vi.mock('fs/promises', async () => (await import('./filesystem-test-harness')).fsPromisesMock)
vi.mock(
  '../wsl-unc-delete',
  async () => (await import('./filesystem-test-harness')).wslUncDeleteMock
)
vi.mock(
  '../crash-reporting/crash-breadcrumb-store',
  async () => (await import('./filesystem-test-harness')).crashBreadcrumbMock
)
vi.mock(
  '../local-downloaded-folder-promotion',
  async () => (await import('./filesystem-test-harness')).folderPromotionMock
)
vi.mock(
  '../git/status',
  async () => (await import('./filesystem-test-harness')).gitStatusModuleMock
)
vi.mock(
  '../git/check-ignored-paths',
  async () => (await import('./filesystem-test-harness')).gitIgnoredPathsMock
)
vi.mock('../git/worktree', async () => (await import('./filesystem-test-harness')).gitWorktreeMock)
vi.mock(
  '../providers/ssh-filesystem-dispatch',
  async () => (await import('./filesystem-test-harness')).sshFilesystemDispatchMock
)
vi.mock(
  '../providers/ssh-git-dispatch',
  async () => (await import('./filesystem-test-harness')).sshGitDispatchMock
)
vi.mock('./local-worktree-runtime-options', () => ({
  getLocalGitOptionsForRegisteredWorktree: getLocalGitOptionsForRegisteredWorktreeMock,
  getLocalGitOptionsForRepo: vi.fn(() => ({})),
  getLocalRepoForRegisteredWorktree: vi.fn(() => undefined)
}))

import { registerFilesystemHandlers } from './filesystem'
import {
  registerWorktreeRootsForRepo,
  invalidateAuthorizedRootsCache
} from './registered-worktree-roots-cache'

// Why: `git:conflictOperation` reads the worktree's `.git` pointer directly, so it has to run in
// the same host namespace as that worktree's git — a WSL project answers in the guest namespace.
describe('git:conflictOperation local routing', () => {
  beforeEach(() => {
    resetFilesystemIpcMocks()
    invalidateAuthorizedRootsCache()
    getLocalGitOptionsForRegisteredWorktreeMock.mockReset()
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({ wslDistro: 'Ubuntu' })
    detectConflictOperationMock.mockResolvedValue('merge')
  })

  it("probes with the registered worktree's local git options", async () => {
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:conflictOperation')!(null, { worktreePath: WORKTREE_FEATURE_PATH })
    ).resolves.toBe('merge')

    expect(getLocalGitOptionsForRegisteredWorktreeMock).toHaveBeenCalledWith(
      store,
      WORKTREE_FEATURE_PATH,
      WORKTREE_FEATURE_PATH
    )
    expect(detectConflictOperationMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, {
      wslDistro: 'Ubuntu'
    })
  })
})
