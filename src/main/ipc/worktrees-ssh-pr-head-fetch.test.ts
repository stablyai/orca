import { beforeEach, describe, expect, it, vi } from 'vitest'
import { REVIEW_HEAD_FETCH_TIMEOUT_MS } from '../../shared/review-head-tracking-ref'
import { getPullRequestPushTargetMock, gitExecFileAsyncMock } from './worktrees-test-module-mocks'
import { handlers, harnessRepo, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { ORIGIN_HEAD_COMPONENT, ORIGIN_REMOTE_URL } from './worktrees-test-fixtures'
import type { WorktreeRuntimeStub } from './worktrees-test-runtime-stub'

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
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
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
vi.mock('./pty/provider/registry', async () =>
  (await import('./worktrees-test-module-mocks')).ptyRegistryModuleMock()
)
vi.mock('./pty/provider/state-cleanup', async () =>
  (await import('./worktrees-test-module-mocks')).ptyStateCleanupModuleMock()
)

describe('registerWorktreeHandlers', () => {
  let runtimeStub: WorktreeRuntimeStub

  beforeEach(() => {
    runtimeStub = setupWorktreeHandlers()
  })

  it('resolves a fork PR base even when push-target discovery fails', async () => {
    getPullRequestPushTargetMock.mockRejectedValueOnce(new Error('lookup failed'))
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'abc123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await handlers['worktrees:resolvePrBase'](null, {
      repoId: 'repo-1',
      prNumber: 1849,
      headRefName: 'feat/onboarding-model-choice-782',
      isCrossRepository: true
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'fetch',
        '--no-tags',
        'origin',
        `+refs/pull/1849/head:refs/orca/pull/${ORIGIN_HEAD_COMPONENT}/1849`
      ],
      { cwd: '/workspace/repo', timeout: REVIEW_HEAD_FETCH_TIMEOUT_MS }
    )
    expect(result).toEqual({
      baseBranch: 'abc123',
      headSha: 'abc123',
      branchNameOverride: 'feat/onboarding-model-choice-782'
    })
  })

  // Why: a row may name its SSH host only as `executionHostId`; local git must not run for it.
  it('refuses local git for a PR base on an executionHostId-only SSH repo', async () => {
    store.getRepo.mockReturnValue({ ...harnessRepo, executionHostId: 'ssh:gpu' })
    gitExecFileAsyncMock.mockResolvedValue({ stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' })

    const result = await Promise.resolve(
      handlers['worktrees:resolvePrBase'](null, {
        repoId: 'repo-1',
        prNumber: 1849,
        headRefName: 'feat/x'
      })
    ).catch((error: unknown) => error)

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).toMatch(/SSH/)
  })

  it('falls back to refs/pull/<N>/head when branch fetch fails for a PR', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (
        args[0] === 'fetch' &&
        args[2] ===
          '+refs/heads/feat/onboarding-model-choice-782:refs/remotes/origin/feat/onboarding-model-choice-782'
      ) {
        throw new Error(
          'fatal: could not find remote ref refs/heads/feat/onboarding-model-choice-782'
        )
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'abc123\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await handlers['worktrees:resolvePrBase'](null, {
      repoId: 'repo-1',
      prNumber: 1849,
      headRefName: 'feat/onboarding-model-choice-782'
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'fetch',
        'origin',
        '+refs/heads/feat/onboarding-model-choice-782:refs/remotes/origin/feat/onboarding-model-choice-782'
      ],
      { cwd: '/workspace/repo' }
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'fetch',
        '--no-tags',
        'origin',
        `+refs/pull/1849/head:refs/orca/pull/${ORIGIN_HEAD_COMPONENT}/1849`
      ],
      { cwd: '/workspace/repo', timeout: REVIEW_HEAD_FETCH_TIMEOUT_MS }
    )
    expect(result).toEqual({
      baseBranch: 'abc123',
      headSha: 'abc123',
      branchNameOverride: 'feat/onboarding-model-choice-782'
    })
  })

  it('does not fall back to refs/pull/<N>/head when branch fetch hits a network failure', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (
        args[0] === 'fetch' &&
        args[2] ===
          '+refs/heads/feat/onboarding-model-choice-782:refs/remotes/origin/feat/onboarding-model-choice-782'
      ) {
        throw new Error('fatal: unable to access repo: Could not resolve host: github.com')
      }
      return { stdout: '', stderr: '' }
    })

    const result = await handlers['worktrees:resolvePrBase'](null, {
      repoId: 'repo-1',
      prNumber: 1849,
      headRefName: 'feat/onboarding-model-choice-782'
    })

    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(['fetch', '--no-tags']),
      expect.anything()
    )
    expect(result).toMatchObject({
      error:
        'Failed to fetch origin/feat/onboarding-model-choice-782: fatal: unable to access repo: Could not resolve host: github.com'
    })
  })

  it('delegates GitLab MR base resolution through the runtime implementation', async () => {
    runtimeStub.resolveManagedMrBase.mockResolvedValueOnce({
      baseBranch: 'fork-mr-sha',
      pushTarget: { remoteName: 'origin', branchName: 'feature/mr' }
    })

    const result = await handlers['worktrees:resolveMrBase'](null, {
      repoId: 'repo-1',
      mrIid: 42,
      sourceBranch: 'feature/mr',
      isCrossRepository: true
    })

    expect(runtimeStub.resolveManagedMrBase).toHaveBeenCalledWith({
      repoSelector: 'id:repo-1',
      mrIid: 42,
      sourceBranch: 'feature/mr',
      isCrossRepository: true
    })
    expect(result).toMatchObject({
      baseBranch: 'fork-mr-sha',
      pushTarget: { remoteName: 'origin', branchName: 'feature/mr' }
    })
  })
})
