import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listWorktreesMock,
  addWorktreeMock,
  getBranchConflictKindMock,
  getPRForBranchMock,
  computeWorktreePathMock
} from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'

vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../git/worktree', async () =>
  (await import('./worktrees-test-module-mocks')).gitWorktreeModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./worktrees-test-module-mocks')).gitRunnerModuleMock()
)
vi.mock('../git/repo', async () =>
  (await import('./worktrees-test-module-mocks')).gitRepoModuleMock()
)
vi.mock('../git/git-username', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLocalGitUsername: (await import('./worktrees-test-module-mocks'))
    .resolveLocalGitUsernameMock
}))
vi.mock('../github/client', async () =>
  (await import('./worktrees-test-module-mocks')).githubClientModuleMock()
)
vi.mock('../source-control/hosted-review', async () =>
  (await import('./worktrees-test-module-mocks')).hostedReviewModuleMock()
)
vi.mock('../providers/ssh-git-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshGitDispatchModuleMock()
)
vi.mock('../providers/ssh-filesystem-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshFilesystemDispatchModuleMock()
)
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
)
vi.mock('./ssh', async () => (await import('./worktrees-test-module-mocks')).sshModuleMock())
vi.mock('../ssh/ssh-target-registry', async () =>
  (await import('./worktrees-test-module-mocks')).sshTargetRegistryModuleMock()
)
vi.mock('../hooks', async () => (await import('./worktrees-test-module-mocks')).hooksModuleMock())
vi.mock('../setup-runner-script-text', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupRunnerScriptTextModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../setup-hook-env-vars', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupHookEnvVarsModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('./worktree-logic', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../terminal-history-deletion', async () =>
  (await import('./worktrees-test-module-mocks')).terminalHistoryDeletionModuleMock()
)
vi.mock('../ports/advertised-url-watcher', async () =>
  (await import('./worktrees-test-module-mocks')).advertisedUrlWatcherModuleMock()
)
vi.mock('../workspace-cleanup-scan-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupScanSnapshotModuleMock()
)
vi.mock('../workspace-space-analysis-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceSpaceAnalysisSnapshotModuleMock()
)
vi.mock('../workspace-cleanup-removal-snapshot-prune', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupRemovalSnapshotPruneModuleMock()
)
vi.mock('../runtime/worktree-teardown', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeTeardownModuleMock()
)
vi.mock('./pty', async () => (await import('./worktrees-test-module-mocks')).ptyModuleMock())

describe('worktree create when the PR head is not in origin', () => {
  beforeEach(() => {
    setupWorktreeHandlers()
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0
    })
    listWorktreesMock.mockImplementation(async () =>
      addWorktreeMock.mock.calls.map((call: unknown[]) => ({
        path: call[1] as string,
        head: 'abc123',
        branch: `refs/heads/${call[2] as string}`,
        isBare: false,
        isMainWorktree: false
      }))
    )
    computeWorktreePathMock.mockImplementation(
      (_repoPath: string, name: string) => `/workspace/${name}`
    )
    // A clone whose `origin` is a fork: branch lookup asks for `origin-owner:branch`
    // and finds nothing, because the PR head lives upstream. Only the exact
    // by-number lookup can see it.
    getPRForBranchMock.mockImplementation(
      async (_repoPath: unknown, _branch: unknown, linkedPRNumber?: unknown) =>
        linkedPRNumber === 42
          ? {
              number: 42,
              title: 'Upstream PR',
              state: 'open',
              url: 'https://example.com/pr/42',
              checksStatus: 'success',
              updatedAt: '2026-06-16T00:00:00.000Z',
              mergeable: 'UNKNOWN',
              headRefName: 'feature/fix'
            }
          : null
    )
  })

  it('keeps the PR branch name when only the by-number lookup can see the PR', async () => {
    getBranchConflictKindMock.mockResolvedValueOnce('remote')

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'fix-title',
      baseBranch: 'abc123',
      branchNameOverride: 'feature/fix',
      linkedPR: 42,
      pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
    })

    expect(addWorktreeMock.mock.calls.map((call: unknown[]) => call[2])).toEqual(['feature/fix'])
  })

  it('still suffixes when the selected PR heads a different branch', async () => {
    getBranchConflictKindMock.mockResolvedValueOnce('remote')
    getPRForBranchMock.mockImplementation(
      async (_repoPath: unknown, _branch: unknown, linkedPRNumber?: unknown) =>
        linkedPRNumber === 42
          ? {
              number: 42,
              title: 'Upstream PR',
              state: 'open',
              url: 'https://example.com/pr/42',
              checksStatus: 'success',
              updatedAt: '2026-06-16T00:00:00.000Z',
              mergeable: 'UNKNOWN',
              headRefName: 'someone/else'
            }
          : null
    )

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'fix-title',
      baseBranch: 'abc123',
      branchNameOverride: 'feature/fix',
      linkedPR: 42,
      pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
    })

    expect(addWorktreeMock.mock.calls.map((call: unknown[]) => call[2])).toEqual(['feature/fix-2'])
  })
})
