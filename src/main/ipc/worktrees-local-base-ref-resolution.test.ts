import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import {
  listWorktreesMock,
  addWorktreeMock,
  resolveDefaultBaseRefWithLocalGitMock,
  resolveDefaultBaseRefViaExecMock,
  gitExecFileAsyncMock
} from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'
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

  it('awaits a cold refresh before creating from an existing remote-tracking base', async () => {
    const remoteBase = {
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    }
    let resolveFetch!: () => void
    const pendingFetch = new Promise<{ ok: true }>((resolve) => {
      resolveFetch = () => resolve({ ok: true })
    })
    runtimeStub.resolveRemoteTrackingBase.mockResolvedValue(remoteBase)
    runtimeStub.hasRemoteTrackingRef.mockResolvedValue(true)
    runtimeStub.getOrStartRemoteTrackingBaseRefresh.mockReturnValue(pendingFetch)
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard',
        head: 'created-sha',
        branch: 'improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (
        args[0] === 'rev-parse' &&
        (args.includes('refs/remotes/origin/master^{commit}') ||
          args.includes('refs/heads/origin/master^{commit}'))
      ) {
        throw new Error('missing ref')
      }
      return { stdout: 'created-sha\n', stderr: '' }
    })

    const createPromise = handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    }) as Promise<unknown>

    const earlyResult = await Promise.race([
      createPromise.then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 0))
    ])
    expect(earlyResult).toBe('pending')
    expect(addWorktreeMock).not.toHaveBeenCalled()

    expect(runtimeStub.getOrStartRemoteTrackingBaseRefresh).toHaveBeenCalledWith(
      '/workspace/repo',
      remoteBase
    )
    expect(runtimeStub.fetchRemoteWithCache).not.toHaveBeenCalled()
    resolveFetch()
    const result = (await createPromise) as CreateWorktreeResult
    expect(addWorktreeMock).toHaveBeenCalled()
    expect(result.worktree.id).toBe('repo-1::/workspace/improve-dashboard')
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/improve-dashboard',
      expect.objectContaining({ baseRef: 'refs/remotes/origin/main' })
    )
  })

  it('creates from the detected default base when the persisted base is stale', async () => {
    // Regression: a stale persisted repo base must fall back to the detected primary default instead of blocking creation.
    const remoteBase = {
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    }
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      worktreeBaseRef: 'origin/master'
    })
    runtimeStub.resolveRemoteTrackingBase.mockImplementation(async (_repoPath, baseBranch) =>
      baseBranch === 'origin/main' ? remoteBase : null
    )
    runtimeStub.hasRemoteTrackingRef.mockResolvedValue(true)
    runtimeStub.getOrStartRemoteTrackingBaseRefresh.mockResolvedValue({
      ok: true,
      errorKind: 'git_error'
    })
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard',
        head: 'created-sha',
        branch: 'improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (
        args[0] === 'rev-parse' &&
        (args.includes('refs/remotes/origin/master^{commit}') ||
          args.includes('refs/heads/origin/master^{commit}'))
      ) {
        throw new Error('missing ref')
      }
      return { stdout: 'created-sha\n', stderr: '' }
    })

    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })) as CreateWorktreeResult

    expect(addWorktreeMock).toHaveBeenCalled()
    expect(runtimeStub.resolveRemoteTrackingBase).toHaveBeenCalledWith(
      '/workspace/repo',
      'origin/master'
    )
    expect(runtimeStub.resolveRemoteTrackingBase).toHaveBeenCalledWith(
      '/workspace/repo',
      'origin/main'
    )
    expect(runtimeStub.getOrStartRemoteTrackingBaseRefresh).toHaveBeenCalledWith(
      '/workspace/repo',
      remoteBase
    )
    expect(result.worktree.id).toBe('repo-1::/workspace/improve-dashboard')
  })

  it('keeps a usable persisted local branch base when a detected default exists', async () => {
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      worktreeBaseRef: 'develop'
    })
    runtimeStub.resolveRemoteTrackingBase.mockResolvedValue(null)
    runtimeStub.getOrStartRemoteTrackingBaseRefresh.mockResolvedValue({
      ok: false,
      errorKind: 'git_error'
    })
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard',
        head: 'created-sha',
        branch: 'improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/heads/develop^{commit}')) {
        return { stdout: 'develop-sha\n', stderr: '' }
      }
      if (args[0] === 'fetch') {
        throw new Error('network unavailable')
      }
      return { stdout: 'created-sha\n', stderr: '' }
    })

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'improve-dashboard'
      })
    ).resolves.toEqual(expect.objectContaining({ worktree: expect.any(Object) }))

    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/improve-dashboard',
      'improve-dashboard',
      'develop',
      false
    )
  })

  it('keeps a usable persisted slash-named local branch base that matches a remote prefix', async () => {
    const remoteBase = {
      remote: 'team',
      branch: 'feature',
      ref: 'refs/remotes/team/feature',
      base: 'team/feature'
    }
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      worktreeBaseRef: 'team/feature'
    })
    runtimeStub.resolveRemoteTrackingBase.mockImplementation(async (_repoPath, baseBranch) =>
      baseBranch === 'team/feature' ? remoteBase : null
    )
    runtimeStub.hasRemoteTrackingRef.mockResolvedValue(false)
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/slash-local-base',
        head: 'created-sha',
        branch: 'slash-local-base',
        isBare: false,
        isMainWorktree: false
      }
    ])
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/team/feature^{commit}')) {
        throw new Error('missing remote-tracking ref')
      }
      if (args[0] === 'rev-parse' && args.includes('refs/heads/team/feature^{commit}')) {
        return { stdout: 'team-feature-sha\n', stderr: '' }
      }
      if (args[0] === 'fetch') {
        throw new Error('network unavailable')
      }
      return { stdout: 'created-sha\n', stderr: '' }
    })

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'slash-local-base'
    })

    expect(result).toEqual(expect.objectContaining({ worktree: expect.any(Object) }))
    expect((result as CreateWorktreeResult).baseFallback).toEqual({
      requestedRef: 'team/feature',
      localRef: 'team/feature'
    })
    expect(runtimeStub.getOrStartRemoteTrackingBaseRefresh).not.toHaveBeenCalled()
    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/slash-local-base',
      'slash-local-base',
      'team/feature',
      false
    )
  })

  it('uses a local branch when its missing remote-tracking base cannot refresh', async () => {
    const remoteBase = {
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    }
    runtimeStub.resolveRemoteTrackingBase.mockResolvedValue(remoteBase)
    runtimeStub.hasRemoteTrackingRef.mockResolvedValue(false)
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/offline-local-main',
        head: 'created-sha',
        branch: 'offline-local-main',
        isBare: false,
        isMainWorktree: false
      }
    ])
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/main^{commit}')) {
        throw new Error('missing remote-tracking ref')
      }
      if (args[0] === 'rev-parse' && args.includes('refs/heads/main^{commit}')) {
        return { stdout: 'main-sha\n', stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        return { stdout: '', stderr: '' }
      }
      return { stdout: 'created-sha\n', stderr: '' }
    })

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'offline-local-main',
      baseBranch: 'origin/main'
    })

    expect(result).toEqual(expect.objectContaining({ worktree: expect.any(Object) }))
    expect((result as CreateWorktreeResult).baseFallback).toEqual({
      requestedRef: 'origin/main',
      localRef: 'main'
    })
    expect(runtimeStub.getOrStartRemoteTrackingBaseRefresh).not.toHaveBeenCalled()
    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/offline-local-main',
      'offline-local-main',
      'main',
      false
    )
  })

  it('keeps an explicit base strict when the pre-create refresh fails', async () => {
    const remoteBase = {
      remote: 'origin',
      branch: 'master',
      ref: 'refs/remotes/origin/master',
      base: 'origin/master'
    }
    runtimeStub.resolveRemoteTrackingBase.mockResolvedValue(remoteBase)
    runtimeStub.hasRemoteTrackingRef.mockResolvedValue(false)
    runtimeStub.getOrStartRemoteTrackingBaseRefresh.mockResolvedValue({
      ok: false,
      errorKind: 'git_error'
    })
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      worktreeBaseRef: 'origin/main'
    })

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'improve-dashboard',
        baseBranch: 'origin/master'
      })
    ).rejects.toThrow(
      'Could not refresh base ref "origin/master" from "origin". Check your network and try again.'
    )

    expect(addWorktreeMock).not.toHaveBeenCalled()
    expect(resolveDefaultBaseRefViaExecMock).not.toHaveBeenCalled()
  })

  it('delegates remote-tracking base freshness to the runtime before create', async () => {
    const remoteBase = {
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    }
    runtimeStub.resolveRemoteTrackingBase.mockResolvedValue(remoteBase)
    runtimeStub.hasRemoteTrackingRef.mockResolvedValue(true)
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard',
        head: 'created-sha',
        branch: 'improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'created-sha\n', stderr: '' })

    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })) as CreateWorktreeResult

    expect(runtimeStub.getOrStartRemoteTrackingBaseRefresh).toHaveBeenCalledWith(
      '/workspace/repo',
      remoteBase
    )
    expect(result).toEqual(
      expect.objectContaining({
        worktree: expect.objectContaining({ id: 'repo-1::/workspace/improve-dashboard' })
      })
    )
  })

  it('threads the local base update suggestion from local create results', async () => {
    const remoteBase = {
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    }
    runtimeStub.resolveRemoteTrackingBase.mockResolvedValue(remoteBase)
    runtimeStub.hasRemoteTrackingRef.mockResolvedValue(true)
    addWorktreeMock.mockResolvedValue({
      localBaseRefUpdateSuggestion: {
        baseRef: 'origin/main',
        localBranch: 'main',
        behind: 2
      }
    })
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard',
        head: 'created-sha',
        branch: 'improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'created-sha\n', stderr: '' })

    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })) as CreateWorktreeResult

    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/improve-dashboard',
      'improve-dashboard',
      'origin/main',
      false,
      false,
      {
        suggestLocalBaseRefUpdate: true,
        remoteTrackingBase: {
          remote: 'origin',
          branch: 'main',
          ref: 'refs/remotes/origin/main',
          base: 'origin/main'
        }
      }
    )
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      'repo-1::/workspace/improve-dashboard',
      expect.objectContaining({ baseRef: 'refs/remotes/origin/main' })
    )
    expect(result.localBaseRefUpdateSuggestion).toEqual({
      baseRef: 'origin/main',
      localBranch: 'main',
      behind: 2
    })
  })

  it('throws a clear error when no default base ref can be resolved', async () => {
    // Why: guard against regressing to a silent 'origin/main' fallback; an unresolved default base must fail loudly, not hand a non-existent ref to `git worktree add`.
    resolveDefaultBaseRefWithLocalGitMock.mockResolvedValue(null)
    store.getRepo.mockReturnValue({
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      worktreeBaseRef: null
    })

    await expect(
      handlers['worktrees:create'](null, {
        repoId: 'repo-1',
        name: 'improve-dashboard'
      })
    ).rejects.toThrow(/Could not resolve a default base ref/)
    expect(addWorktreeMock).not.toHaveBeenCalled()
  })
})
