import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type { ProviderRequestId } from '../../shared/detected-worktree-provider-contract'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { DETECTED_WORKTREE_PROVIDER_TIMEOUT_MS } from './worktrees'
import { getSshProviderAuthority, rotateSshProviderAuthority } from '../ssh/ssh-provider-authority'
import { getSshGitProviderMock } from './worktrees-test-module-mocks'
import { handlers, ipcEvent, setupWorktreeHandlers, store } from './worktrees-test-harness'

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
  beforeEach(() => {
    setupWorktreeHandlers()
  })

  it.each([
    ['malformed', 'ssh:%'],
    ['contradictory', toSshExecutionHostId('target-b')]
  ])(
    'rejects %s repo provenance introduced during the SSH await',
    async (_caseName, invalidExecutionHostId) => {
      let resolveList: (worktrees: GitWorktreeInfo[]) => void = () => {}
      const provider = {
        listWorktrees: vi.fn(
          () =>
            new Promise<GitWorktreeInfo[]>((resolve) => {
              resolveList = resolve
            })
        )
      }
      const sshRepo = {
        id: 'repo-1',
        path: '/remote/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: 'target-a'
      }
      let repos: Repo[] = [sshRepo]
      store.getRepos.mockImplementation(() => repos)
      getSshGitProviderMock.mockReturnValue(provider)

      const pending = handlers['worktrees:listDetected'](ipcEvent, {
        providerRequestId: `request-${_caseName}` as ProviderRequestId,
        repoId: sshRepo.id,
        executionHostId: toSshExecutionHostId('target-a'),
        expectedAuthority: getSshProviderAuthority('target-a')
      })
      await Promise.resolve()
      repos = [
        sshRepo,
        {
          ...sshRepo,
          path: '/remote/conflicting-repo',
          executionHostId: invalidExecutionHostId as Repo['executionHostId']
        }
      ]
      resolveList([
        {
          path: '/remote/repo',
          head: 'stale-head',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])

      await expect(pending).resolves.toMatchObject({ status: 'stale' })
      expect(store.setWorktreeMeta).not.toHaveBeenCalled()
      expect(store.removeWorktreeLineage).not.toHaveBeenCalled()
    }
  )

  it('aborts all old-authority SSH calls on rotation with target isolation', async () => {
    const repos = [
      {
        id: 'repo-a',
        path: '/remote/repo-a',
        displayName: 'repo A',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: 'target-a'
      },
      {
        id: 'repo-b',
        path: '/remote/repo-b',
        displayName: 'repo B',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: 'target-b'
      }
    ]
    const resolveA: ((worktrees: GitWorktreeInfo[]) => void)[] = []
    let resolveB: (worktrees: GitWorktreeInfo[]) => void = () => {}
    const signalsA: AbortSignal[] = []
    let signalB: AbortSignal | undefined
    const abortsA = [vi.fn(), vi.fn()]
    const abortB = vi.fn()
    const providerA = {
      listWorktrees: vi.fn((_path: string, options?: { signal?: AbortSignal }) => {
        const index = signalsA.length
        const signal = options?.signal
        if (signal) {
          signalsA.push(signal)
          signal.addEventListener('abort', abortsA[index])
        }
        return new Promise<GitWorktreeInfo[]>((resolve) => {
          resolveA.push(resolve)
        })
      })
    }
    const providerB = {
      listWorktrees: vi.fn((_path: string, options?: { signal?: AbortSignal }) => {
        signalB = options?.signal
        signalB?.addEventListener('abort', abortB)
        return new Promise<GitWorktreeInfo[]>((resolve) => {
          resolveB = resolve
        })
      })
    }
    store.getRepos.mockReturnValue(repos)
    getSshGitProviderMock.mockImplementation((targetId) =>
      targetId === 'target-a' ? providerA : providerB
    )
    const authorityA = getSshProviderAuthority('target-a')
    const authorityB = getSshProviderAuthority('target-b')
    const request = (
      repo: (typeof repos)[number],
      providerRequestId: ProviderRequestId,
      expectedAuthority: ReturnType<typeof getSshProviderAuthority>
    ) =>
      handlers['worktrees:listDetected'](ipcEvent, {
        providerRequestId,
        repoId: repo.id,
        executionHostId: toSshExecutionHostId(repo.connectionId),
        expectedAuthority
      })

    const pendingA1 = request(repos[0], 'request-a1' as ProviderRequestId, authorityA)
    const pendingA2 = request(repos[0], 'request-a2' as ProviderRequestId, authorityA)
    const pendingB = request(repos[1], 'request-b' as ProviderRequestId, authorityB)
    await Promise.resolve()

    rotateSshProviderAuthority('target-a')
    rotateSshProviderAuthority('target-a')

    expect(signalsA).toHaveLength(2)
    expect(signalsA.every((signal) => signal.aborted)).toBe(true)
    expect(abortsA[0]).toHaveBeenCalledOnce()
    expect(abortsA[1]).toHaveBeenCalledOnce()
    expect(signalB?.aborted).toBe(false)
    expect(abortB).not.toHaveBeenCalled()
    await expect(Promise.all([pendingA1, pendingA2])).resolves.toEqual([
      expect.objectContaining({ status: 'canceled', providerRequestId: 'request-a1' }),
      expect.objectContaining({ status: 'canceled', providerRequestId: 'request-a2' })
    ])

    resolveB([])
    await expect(pendingB).resolves.toMatchObject({
      status: 'complete',
      providerRequestId: 'request-b'
    })
    rotateSshProviderAuthority('target-b')
    expect(abortB).not.toHaveBeenCalled()

    store.setWorktreeMeta.mockClear()
    store.removeWorktreeLineage.mockClear()
    for (const resolve of resolveA) {
      resolve([
        {
          path: '/remote/repo-a',
          head: 'late-head',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
    }
    await Promise.resolve()
    await Promise.resolve()
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
    expect(store.removeWorktreeLineage).not.toHaveBeenCalled()
  })

  it('cancels an SSH provider request by sender-scoped provider request ID', async () => {
    let providerSignal: AbortSignal | undefined
    const provider = {
      listWorktrees: vi.fn(
        (_repoPath: string, options?: { signal?: AbortSignal }) =>
          new Promise<GitWorktreeInfo[]>((_resolve, reject) => {
            providerSignal = options?.signal
            providerSignal?.addEventListener(
              'abort',
              () => reject(new DOMException('Canceled', 'AbortError')),
              { once: true }
            )
          })
      )
    }
    const sshRepo = {
      id: 'repo-1',
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'target-a'
    }
    store.getRepos.mockReturnValue([sshRepo])
    getSshGitProviderMock.mockReturnValue(provider)

    const pending = handlers['worktrees:listDetected'](ipcEvent, {
      providerRequestId: 'request-1' as ProviderRequestId,
      repoId: sshRepo.id,
      executionHostId: toSshExecutionHostId('target-a'),
      expectedAuthority: getSshProviderAuthority('target-a')
    })
    await Promise.resolve()
    handlers['worktrees:cancelListDetected'](ipcEvent, {
      providerRequestId: 'request-1' as ProviderRequestId
    })

    expect(providerSignal?.aborted).toBe(true)
    await expect(pending).resolves.toMatchObject({
      status: 'canceled',
      providerRequestId: 'request-1'
    })
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
    expect(store.removeWorktreeLineage).not.toHaveBeenCalled()
  })

  it('settles a noncooperative SSH provider at the main-owned deadline and cleans up', async () => {
    vi.useFakeTimers()
    try {
      let providerSignal: AbortSignal | undefined
      let rejectLateRequest: (error: Error) => void = () => {}
      const provider = {
        listWorktrees: vi.fn((_repoPath: string, options?: { signal?: AbortSignal }) => {
          if (provider.listWorktrees.mock.calls.length > 1) {
            return Promise.resolve([])
          }
          return new Promise<GitWorktreeInfo[]>((_resolve, reject) => {
            rejectLateRequest = reject
            // Why: this provider intentionally ignores abort to exercise the main-owned deadline.
            if (options?.signal) {
              providerSignal = options?.signal
            }
          })
        })
      }
      const sshRepo = {
        id: 'repo-1',
        path: '/remote/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: 'target-a'
      }
      store.getRepos.mockReturnValue([sshRepo])
      getSshGitProviderMock.mockReturnValue(provider)

      const pending = handlers['worktrees:listDetected'](ipcEvent, {
        providerRequestId: 'request-1' as ProviderRequestId,
        repoId: sshRepo.id,
        executionHostId: toSshExecutionHostId('target-a'),
        expectedAuthority: getSshProviderAuthority('target-a')
      })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(DETECTED_WORKTREE_PROVIDER_TIMEOUT_MS - 1)
      let settled = false
      void Promise.resolve(pending).finally(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(1)

      expect(providerSignal?.aborted).toBe(true)
      await expect(pending).resolves.toMatchObject({
        status: 'timed-out',
        providerRequestId: 'request-1'
      })
      expect(vi.getTimerCount()).toBe(0)

      await expect(
        handlers['worktrees:listDetected'](ipcEvent, {
          providerRequestId: 'request-1' as ProviderRequestId,
          repoId: sshRepo.id,
          executionHostId: toSshExecutionHostId('target-a'),
          expectedAuthority: getSshProviderAuthority('target-a')
        })
      ).resolves.toMatchObject({
        status: 'complete',
        providerRequestId: 'request-1'
      })

      store.setWorktreeMeta.mockClear()
      store.removeWorktreeLineage.mockClear()
      rejectLateRequest(new Error('late provider failure'))
      await Promise.resolve()
      expect(store.setWorktreeMeta).not.toHaveBeenCalled()
      expect(store.removeWorktreeLineage).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
