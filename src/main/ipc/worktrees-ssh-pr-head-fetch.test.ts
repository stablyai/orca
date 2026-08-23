import { beforeEach, describe, expect, it, vi } from 'vitest'
import { REVIEW_HEAD_FETCH_TIMEOUT_MS } from '../../shared/review-head-tracking-ref'
import {
  getPullRequestPushTargetMock,
  gitExecFileAsyncMock,
  getSshGitProviderMock,
  getActiveMultiplexerMock
} from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'
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

describe('registerWorktreeHandlers', () => {
  let runtimeStub: WorktreeRuntimeStub

  beforeEach(() => {
    runtimeStub = setupWorktreeHandlers()
  })

  it('fetches the same-repo PR head via the SSH tracking-ref RPC, not git.exec', async () => {
    const fetchRemoteTrackingRef = vi.fn(async () => {})
    const exec = vi.fn(async (args: string[]) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'def456\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    getSshGitProviderMock.mockReturnValue({ exec, fetchRemoteTrackingRef })
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    })

    const result = await handlers['worktrees:resolvePrBase'](null, {
      repoId: 'repo-1',
      prNumber: 42,
      headRefName: 'feature/add-feature',
      isCrossRepository: false
    })

    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith(
      '/workspace/repo',
      'origin',
      'feature/add-feature',
      'refs/remotes/origin/feature/add-feature'
    )
    expect(exec).not.toHaveBeenCalledWith(expect.arrayContaining(['fetch']), expect.anything())
    expect(result).toMatchObject({
      baseBranch: 'def456',
      headSha: 'def456',
      branchNameOverride: 'feature/add-feature',
      pushTarget: { remoteName: 'origin', branchName: 'feature/add-feature' }
    })
  })

  it('fetches a fork PR head via the SSH pull-head RPC, not git.exec', async () => {
    const durableLocalRef = `refs/orca/pull/${ORIGIN_HEAD_COMPONENT}/42`
    const fetchGitHubPullRequestHead = vi.fn(async () => durableLocalRef)
    const exec = vi.fn(async (args: string[]) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[2] === `${durableLocalRef}^{commit}`) {
        return { stdout: 'fork-head-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    getSshGitProviderMock.mockReturnValue({
      exec,
      fetchGitHubPullRequestHead,
      fetchRemoteTrackingRef: vi.fn()
    })
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    })

    const result = await handlers['worktrees:resolvePrBase'](null, {
      repoId: 'repo-1',
      prNumber: 42,
      headRefName: 'contributor/fix',
      isCrossRepository: true
    })

    expect(fetchGitHubPullRequestHead).toHaveBeenCalledWith('/workspace/repo', 'origin', 42)
    expect(exec).not.toHaveBeenCalledWith(expect.arrayContaining(['fetch']), expect.anything())
    expect(result).toMatchObject({
      baseBranch: 'fork-head-sha',
      headSha: 'fork-head-sha',
      branchNameOverride: 'contributor/fix'
    })
  })

  it('fetches a fork PR head from origin, not the first remote, over SSH', async () => {
    const durableLocalRef = `refs/orca/pull/${ORIGIN_HEAD_COMPONENT}/42`
    const fetchGitHubPullRequestHead = vi.fn(async () => durableLocalRef)
    // Why: `fork` is listed first, but fork PR heads live on the hosting remote (origin).
    const exec = vi.fn(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return {
          stdout: `git@github.com:org/${args[2] === 'origin' ? 'repo' : 'fork'}.git\n`,
          stderr: ''
        }
      }
      if (args[0] === 'remote') {
        return { stdout: 'fork\norigin\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[2] === `${durableLocalRef}^{commit}`) {
        return { stdout: 'fork-head-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    getSshGitProviderMock.mockReturnValue({
      exec,
      fetchGitHubPullRequestHead,
      fetchRemoteTrackingRef: vi.fn()
    })
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    })

    const result = await handlers['worktrees:resolvePrBase'](null, {
      repoId: 'repo-1',
      prNumber: 42,
      headRefName: 'contributor/fix',
      isCrossRepository: true
    })

    expect(fetchGitHubPullRequestHead).toHaveBeenCalledWith('/workspace/repo', 'origin', 42)
    expect(result).toMatchObject({
      baseBranch: 'fork-head-sha',
      headSha: 'fork-head-sha',
      branchNameOverride: 'contributor/fix'
    })
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

  it('persists linked issue, PR, and selected agent metadata during remote create', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: 'origin/main'
    }
    const provider = {
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'base123',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/remote/repo-nautilus-2',
          head: 'abc123',
          branch: 'refs/heads/nautilus-2',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      worktreeIsClean: vi.fn().mockResolvedValue({ clean: true })
    }
    const mux = {
      request: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue(mux)
    store.getRetiredWorktreeNameRegistry.mockReturnValue({ exhaustedTiers: 0, names: ['nautilus'] })
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'nautilus',
      nameWasGenerated: true,
      linkedIssue: 123,
      linkedPR: 456,
      createdWithAgent: 'codex',
      linkedLinearIssue: 'ENG-123',
      manualOrder: 123_456
    })

    expect(provider.exec).not.toHaveBeenCalledWith(
      ['config', '--get', 'github.user'],
      '/remote/repo'
    )
    expect(provider.exec).not.toHaveBeenCalledWith(
      ['config', '--get', 'user.username'],
      '/remote/repo'
    )
    expect(provider.listWorktrees).toHaveBeenCalledTimes(1)
    expect(provider.worktreeIsClean).not.toHaveBeenCalled()
    expect(store.addRetiredWorktreeName).toHaveBeenCalledWith('repo-ssh', 'nautilus-2')
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-ssh::/remote/repo-nautilus-2',
      expect.objectContaining({
        linkedIssue: 123,
        linkedPR: 456,
        createdWithAgent: 'codex',
        linkedLinearIssue: 'ENG-123',
        manualOrder: 123_456
      })
    )
    expect(result).toMatchObject({
      worktree: expect.objectContaining({
        linkedIssue: 123,
        linkedPR: 456,
        createdWithAgent: 'codex',
        linkedLinearIssue: 'ENG-123',
        manualOrder: 123_456
      })
    })
  })

  it('leaves a user-typed name reusable on the SSH create path', async () => {
    // Why: `nautilus` is retired here, yet the user typed it — it must neither be skipped nor burned.
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: 'origin/main'
    }
    const provider = {
      exec: vi.fn().mockImplementation(async (args: string[]) => {
        if (args[0] === 'remote') {
          return { stdout: 'origin\n', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'base123',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/remote/repo-nautilus',
          head: 'abc123',
          branch: 'refs/heads/nautilus',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      worktreeIsClean: vi.fn().mockResolvedValue({ clean: true })
    }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue({
      request: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    })
    store.getRetiredWorktreeNameRegistry.mockReturnValue({ exhaustedTiers: 0, names: ['nautilus'] })
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'nautilus'
    })

    expect(store.addRetiredWorktreeName).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      worktree: expect.objectContaining({ path: '/remote/repo-nautilus' })
    })
  })
})
