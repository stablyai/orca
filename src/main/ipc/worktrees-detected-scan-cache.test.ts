import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import type { GitWorktreeInfo, Worktree } from '../../shared/worktree/types'
import { notifyWorktreesChanged } from './worktree-remote'
import { resolveRegisteredWorktreePath } from './registered-worktree-roots-cache'
import { __getDetectedWorktreeScanCacheStatsForTests } from './worktrees'
import { setPlatform, listWorktreesMock } from './worktrees-test-module-mocks'
import { handlers, mainWindow, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { makeWorktreeMeta } from './worktrees-test-fixtures'

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

  it('does not reuse host detected worktree scans for a selected WSL runtime', async () => {
    listWorktreesMock
      .mockResolvedValueOnce([
        {
          path: '/workspace/repo',
          head: 'host-head',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
      .mockResolvedValueOnce([
        {
          path: '/workspace/repo',
          head: 'wsl-head',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])

    const hostResult = (await handlers['worktrees:listDetected'](null, {
      repoId: 'repo-1'
    })) as { worktrees: Worktree[] }
    setPlatform('win32')
    store.getProjects.mockReturnValue([
      {
        id: 'project-1',
        displayName: 'repo',
        badgeColor: '#000',
        sourceRepoIds: ['repo-1'],
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
        createdAt: 0,
        updatedAt: 0
      }
    ])
    const wslResult = (await handlers['worktrees:listDetected'](null, {
      repoId: 'repo-1'
    })) as { worktrees: Worktree[] }

    expect(hostResult.worktrees[0].head).toBe('host-head')
    expect(wslResult.worktrees[0].head).toBe('wsl-head')
    expect(listWorktreesMock).toHaveBeenCalledTimes(2)
    expect(listWorktreesMock).toHaveBeenNthCalledWith(1, '/workspace/repo')
    expect(listWorktreesMock).toHaveBeenNthCalledWith(2, '/workspace/repo', {
      wslDistro: 'Ubuntu'
    })
  })

  it('reuses a recent authoritative detected worktree scan', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/repo',
        head: 'main-head',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ])

    const first = await handlers['worktrees:listDetected'](null, { repoId: 'repo-1' })
    const second = await handlers['worktrees:listDetected'](null, { repoId: 'repo-1' })

    expect(first).toEqual(second)
    expect(listWorktreesMock).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent authoritative detected worktree scans', async () => {
    listWorktreesMock.mockImplementation(async () => {
      await Promise.resolve()
      return [
        {
          path: '/workspace/repo',
          head: 'main-head',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ]
    })

    await Promise.all([
      handlers['worktrees:listDetected'](null, { repoId: 'repo-1' }),
      handlers['worktrees:listDetected'](null, { repoId: 'repo-1' }),
      handlers['worktrees:listDetected'](null, { repoId: 'repo-1' })
    ])

    expect(listWorktreesMock).toHaveBeenCalledTimes(1)
  })

  it('rechecks detected worktree metadata while reusing a cached raw scan', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/repo',
        head: 'main-head',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ])

    let currentMeta = makeWorktreeMeta({ isPinned: false })
    store.getWorktreeMeta.mockImplementation(() => currentMeta)
    store.setWorktreeMeta.mockImplementation(() => currentMeta)
    const first = (await handlers['worktrees:listDetected'](null, {
      repoId: 'repo-1'
    })) as { worktrees: Worktree[] }
    currentMeta = makeWorktreeMeta({ isPinned: true })
    const second = (await handlers['worktrees:listDetected'](null, {
      repoId: 'repo-1'
    })) as { worktrees: Worktree[] }

    expect(first.worktrees[0].isPinned).toBe(false)
    expect(second.worktrees[0].isPinned).toBe(true)
    expect(listWorktreesMock).toHaveBeenCalledTimes(1)
  })

  it('rescans detected worktrees after the scan cache TTL expires', async () => {
    vi.useFakeTimers()
    try {
      listWorktreesMock
        .mockResolvedValueOnce([
          {
            path: '/workspace/repo',
            head: 'main-head',
            branch: 'refs/heads/main',
            isBare: false,
            isMainWorktree: true
          }
        ])
        .mockResolvedValueOnce([
          {
            path: '/workspace/repo',
            head: 'main-head',
            branch: 'refs/heads/main',
            isBare: false,
            isMainWorktree: true
          },
          {
            path: '/workspace/new-worktree',
            head: 'feature-head',
            branch: 'refs/heads/feature',
            isBare: false,
            isMainWorktree: false
          }
        ])

      await handlers['worktrees:listDetected'](null, { repoId: 'repo-1' })
      await vi.advanceTimersByTimeAsync(5_001)
      const second = (await handlers['worktrees:listDetected'](null, {
        repoId: 'repo-1'
      })) as { worktrees: Worktree[] }

      expect(second.worktrees.map((worktree) => worktree.path)).toEqual([
        '/workspace/repo',
        '/workspace/new-worktree'
      ])
      expect(listWorktreesMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts the detected scan cache TTL after a slow scan completes', async () => {
    vi.useFakeTimers()
    try {
      listWorktreesMock
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              setTimeout(
                () =>
                  resolve([
                    {
                      path: '/workspace/repo',
                      head: 'main-head',
                      branch: 'refs/heads/main',
                      isBare: false,
                      isMainWorktree: true
                    }
                  ]),
                6_000
              )
            })
        )
        .mockResolvedValueOnce([
          {
            path: '/workspace/repo',
            head: 'main-head',
            branch: 'refs/heads/main',
            isBare: false,
            isMainWorktree: true
          },
          {
            path: '/workspace/new-worktree',
            head: 'feature-head',
            branch: 'refs/heads/feature',
            isBare: false,
            isMainWorktree: false
          }
        ])

      const first = handlers['worktrees:listDetected'](null, { repoId: 'repo-1' })
      await vi.advanceTimersByTimeAsync(6_000)
      await first
      const second = (await handlers['worktrees:listDetected'](null, {
        repoId: 'repo-1'
      })) as { worktrees: Worktree[] }

      expect(second.worktrees.map((worktree) => worktree.path)).toEqual(['/workspace/repo'])
      expect(listWorktreesMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('invalidates the detected scan cache before worktree change notifications', async () => {
    listWorktreesMock
      .mockResolvedValueOnce([
        {
          path: '/workspace/repo',
          head: 'main-head',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
      .mockResolvedValueOnce([
        {
          path: '/workspace/repo',
          head: 'main-head',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/workspace/new-worktree',
          head: 'feature-head',
          branch: 'refs/heads/feature',
          isBare: false,
          isMainWorktree: false
        }
      ])

    await handlers['worktrees:listDetected'](null, { repoId: 'repo-1' })
    notifyWorktreesChanged(mainWindow as never, 'repo-1')
    const second = (await handlers['worktrees:listDetected'](null, {
      repoId: 'repo-1'
    })) as { worktrees: Worktree[] }

    expect(second.worktrees).toHaveLength(2)
    expect(listWorktreesMock).toHaveBeenCalledTimes(2)
  })

  it('rescans detected worktrees after the local create flow notifies worktree changes', async () => {
    listWorktreesMock
      .mockResolvedValueOnce([
        {
          path: '/workspace/repo',
          head: 'main-head',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
      .mockResolvedValueOnce([
        {
          path: '/workspace/repo',
          head: 'main-head',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/workspace/improve-dashboard',
          head: 'feature-head',
          branch: 'refs/heads/improve-dashboard',
          isBare: false,
          isMainWorktree: false
        }
      ])
      .mockResolvedValueOnce([
        {
          path: '/workspace/repo',
          head: 'main-head',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/workspace/improve-dashboard',
          head: 'feature-head',
          branch: 'refs/heads/improve-dashboard',
          isBare: false,
          isMainWorktree: false
        }
      ])

    await handlers['worktrees:listDetected'](null, { repoId: 'repo-1' })
    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })
    const detected = (await handlers['worktrees:listDetected'](null, {
      repoId: 'repo-1'
    })) as { worktrees: Worktree[] }

    expect(detected.worktrees.map((worktree) => worktree.path)).toEqual([
      '/workspace/repo',
      '/workspace/improve-dashboard'
    ])
    expect(listWorktreesMock).toHaveBeenCalledTimes(3)
  })

  it('does not run fresh-scan side effects from a detected scan invalidated while in flight', async () => {
    let resolveScan: (worktrees: GitWorktreeInfo[]) => void = () => {}
    listWorktreesMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve as (worktrees: GitWorktreeInfo[]) => void
        })
    )
    store.getAllWorktreeLineage.mockReturnValue({
      'repo-1::/workspace/new-worktree': {
        worktreeId: 'repo-1::/workspace/new-worktree',
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: 'repo-1::/workspace/repo',
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'manual',
        capture: {
          source: 'manual-action',
          confidence: 'explicit'
        },
        createdAt: 0
      }
    })

    const pendingList = handlers['worktrees:listDetected'](null, { repoId: 'repo-1' })
    await Promise.resolve()
    notifyWorktreesChanged(mainWindow as never, 'repo-1')
    resolveScan([
      {
        path: '/workspace/repo',
        head: 'main-head',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ])

    await pendingList

    expect(store.removeWorktreeLineage).not.toHaveBeenCalled()
    expect(listWorktreesMock).toHaveBeenCalledTimes(1)
  })

  it('does not retain invalidated detected scans after they settle', async () => {
    let resolveScan: (worktrees: GitWorktreeInfo[]) => void = () => {}
    listWorktreesMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve as (worktrees: GitWorktreeInfo[]) => void
        })
    )

    const pendingList = handlers['worktrees:listDetected'](null, { repoId: 'repo-1' })
    await Promise.resolve()

    expect(__getDetectedWorktreeScanCacheStatsForTests()).toMatchObject({
      cacheSize: 0,
      inFlightSize: 1
    })

    notifyWorktreesChanged(mainWindow as never, 'repo-1')

    expect(__getDetectedWorktreeScanCacheStatsForTests()).toMatchObject({
      cacheSize: 0,
      inFlightSize: 0
    })

    resolveScan([
      {
        path: '/workspace/repo',
        head: 'main-head',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ])
    await pendingList

    expect(__getDetectedWorktreeScanCacheStatsForTests()).toMatchObject({
      cacheSize: 0,
      inFlightSize: 0
    })
  })

  it('does not accumulate scan bookkeeping across prolonged repository churn', async () => {
    listWorktreesMock.mockImplementation(async (repoPath: string) => [
      {
        path: repoPath,
        head: 'main-head',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ])

    for (let index = 0; index < 128; index += 1) {
      const repoId = `repo-${index}`
      store.getRepos.mockReturnValue([
        {
          id: repoId,
          path: `/workspace/${repoId}`,
          displayName: repoId,
          badgeColor: '#000',
          addedAt: 0,
          worktreeBaseRef: null
        }
      ])
      await handlers['worktrees:listDetected'](null, { repoId })
      notifyWorktreesChanged(mainWindow as never, repoId)
    }

    expect(__getDetectedWorktreeScanCacheStatsForTests()).toEqual({
      cacheSize: 0,
      inFlightSize: 0
    })
    expect(listWorktreesMock).toHaveBeenCalledTimes(128)
  })

  it('keeps a replacement scan current after an older scan settles first', async () => {
    const resolvers: ((worktrees: GitWorktreeInfo[]) => void)[] = []
    listWorktreesMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve as (worktrees: GitWorktreeInfo[]) => void)
        })
    )
    const result = [
      {
        path: '/workspace/repo',
        head: 'main-head',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ]

    const staleList = handlers['worktrees:listDetected'](null, { repoId: 'repo-1' })
    await Promise.resolve()
    notifyWorktreesChanged(mainWindow as never, 'repo-1')
    const replacementList = handlers['worktrees:listDetected'](null, { repoId: 'repo-1' })
    await Promise.resolve()

    resolvers[0](result)
    await staleList
    expect(__getDetectedWorktreeScanCacheStatsForTests()).toEqual({
      cacheSize: 0,
      inFlightSize: 1
    })

    resolvers[1](result)
    await replacementList
    expect(__getDetectedWorktreeScanCacheStatsForTests()).toEqual({
      cacheSize: 1,
      inFlightSize: 0
    })
  })

  it('does not let an older scan overwrite a replacement that settles first', async () => {
    const resolvers: ((worktrees: GitWorktreeInfo[]) => void)[] = []
    listWorktreesMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve as (worktrees: GitWorktreeInfo[]) => void)
        })
    )
    store.getAllWorktreeLineage.mockReturnValue({
      'repo-1::/workspace/fresh-worktree': {
        worktreeId: 'repo-1::/workspace/fresh-worktree',
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: 'repo-1::/workspace/repo',
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'manual',
        capture: {
          source: 'manual-action',
          confidence: 'explicit'
        },
        createdAt: 0
      }
    })
    const mainWorktree: GitWorktreeInfo = {
      path: '/workspace/repo',
      head: 'main-head',
      branch: 'refs/heads/main',
      isBare: false,
      isMainWorktree: true
    }

    const staleList = handlers['worktrees:listDetected'](null, { repoId: 'repo-1' })
    await Promise.resolve()
    notifyWorktreesChanged(mainWindow as never, 'repo-1')
    const replacementList = handlers['worktrees:listDetected'](null, { repoId: 'repo-1' })
    await Promise.resolve()

    resolvers[1]([
      mainWorktree,
      {
        path: '/workspace/fresh-worktree',
        head: 'fresh-head',
        branch: 'refs/heads/fresh-worktree',
        isBare: false,
        isMainWorktree: false
      }
    ])
    await replacementList

    resolvers[0]([
      mainWorktree,
      {
        path: '/workspace/stale-worktree',
        head: 'stale-head',
        branch: 'refs/heads/stale-worktree',
        isBare: false,
        isMainWorktree: false
      }
    ])
    await staleList

    const cached = (await handlers['worktrees:listDetected'](null, {
      repoId: 'repo-1'
    })) as { worktrees: Worktree[] }
    expect(cached.worktrees.map((worktree) => worktree.path)).toEqual([
      '/workspace/repo',
      '/workspace/fresh-worktree'
    ])
    expect(store.removeWorktreeLineage).not.toHaveBeenCalled()
    await expect(
      resolveRegisteredWorktreePath('/workspace/fresh-worktree', store as never)
    ).resolves.toBe(resolve('/workspace/fresh-worktree'))
    await expect(
      resolveRegisteredWorktreePath('/workspace/stale-worktree', store as never)
    ).rejects.toThrow('Access denied: unknown repository or worktree path')
    expect(listWorktreesMock).toHaveBeenCalledTimes(2)
    expect(__getDetectedWorktreeScanCacheStatsForTests()).toEqual({
      cacheSize: 1,
      inFlightSize: 0
    })
  })
})
