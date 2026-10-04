import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSshGitProviderMock, getActiveMultiplexerMock } from './worktrees-test-module-mocks'
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
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../setup-hook-env-vars', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupHookEnvVarsModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('./worktree-logic', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(
    await importOriginal<Record<string, unknown>>()
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

const REPO = {
  id: 'repo-ssh',
  path: '/remote/repo',
  displayName: 'ssh',
  badgeColor: '#000',
  addedAt: 0,
  connectionId: 'conn-1',
  worktreeBaseRef: 'origin/main'
}
const REFS = {
  repoPath: '/remote/repo',
  fullRef: 'refs/heads/main',
  remoteTrackingRef: 'refs/remotes/origin/main'
}

function createProvider(relay: {
  refresh?: ReturnType<typeof vi.fn>
  behind?: ReturnType<typeof vi.fn>
}) {
  return {
    exec: vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'for-each-ref') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'show-ref') {
        throw Object.assign(new Error('missing remote ref'), { code: 1 })
      }
      return { stdout: '', stderr: '' }
    }),
    fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
    addWorktree: vi.fn().mockResolvedValue(undefined),
    listWorktrees: vi.fn().mockResolvedValue([
      { path: '/remote/repo', head: 'base123', branch: 'refs/heads/main', isMainWorktree: true },
      {
        path: '/remote/repo-improve-dashboard',
        head: 'abc123',
        branch: 'refs/heads/improve-dashboard',
        isMainWorktree: false
      }
    ]),
    worktreeIsClean: vi.fn().mockResolvedValue({ clean: true }),
    refreshLocalBaseRefForWorktreeCreate: relay.refresh ?? vi.fn(),
    getLocalBaseRefFastForwardableBehind: relay.behind ?? vi.fn()
  }
}

async function createWith(
  provider: ReturnType<typeof createProvider>,
  options: { refreshSetting?: boolean; worktreeBaseRef?: string; registerRoot?: () => void } = {}
) {
  const repo = { ...REPO, worktreeBaseRef: options.worktreeBaseRef ?? REPO.worktreeBaseRef }
  if (options.refreshSetting !== false) {
    store.getSettings.mockReturnValue({
      branchPrefix: 'none',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: true,
      workspaceDir: '/workspace'
    })
  }
  store.getRepos.mockReturnValue([repo])
  store.getRepo.mockReturnValue(repo)
  getSshGitProviderMock.mockReturnValue(provider)
  getActiveMultiplexerMock.mockReturnValue({
    request: vi.fn().mockImplementation(async (method: string) => {
      if (method === 'session.registerRoot') {
        options.registerRoot?.()
      }
    }),
    notify: vi.fn()
  })
  store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)
  const result: unknown = await handlers['worktrees:create'](null, {
    repoId: 'repo-ssh',
    name: 'improve-dashboard'
  })
  return result
}

/** Refresh git the app used to run itself; the relay now owns all of it on the host. */
const APP_SIDE_REFRESH_COMMANDS = ['merge-base', 'log', 'rev-list', 'reset', 'update-ref', 'merge']

describe('SSH local base refresh on worktree create', () => {
  beforeEach(() => {
    setupWorktreeHandlers()
  })

  it('reports the dirty owner the relay found, without inspecting anything itself', async () => {
    const refresh = vi
      .fn()
      .mockResolvedValue({ status: 'skipped_dirty_worktree', ownerWorktreePath: '/remote/repo' })
    const provider = createProvider({ refresh })

    const result = await createWith(provider)

    expect(result).toMatchObject({
      localBaseRefRefresh: {
        status: 'skipped_dirty_worktree',
        baseRef: 'origin/main',
        localBranch: 'main',
        ownerWorktreePath: '/remote/repo'
      }
    })
    const execCommands = provider.exec.mock.calls.map(([args]) => args[0])
    expect(execCommands.filter((c) => APP_SIDE_REFRESH_COMMANDS.includes(c))).toEqual([])
    expect(provider.worktreeIsClean).not.toHaveBeenCalled()
  })

  it('refreshes through the narrow relay RPC with only the refs to move', async () => {
    const refresh = vi
      .fn()
      .mockResolvedValue({ status: 'updated', ownerWorktreePath: '/remote/repo' })
    const provider = createProvider({ refresh })

    const result = await createWith(provider)

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith(REFS)
    expect(provider.getLocalBaseRefFastForwardableBehind).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      localBaseRefRefresh: {
        status: 'updated',
        baseRef: 'origin/main',
        localBranch: 'main',
        ownerWorktreePath: '/remote/repo'
      }
    })
  })

  it('reports a branch the relay moved without a checkout as updated with no owner', async () => {
    const provider = createProvider({ refresh: vi.fn().mockResolvedValue({ status: 'updated' }) })

    const result = await createWith(provider)

    expect(result).toMatchObject({
      localBaseRefRefresh: { status: 'updated', baseRef: 'origin/main', localBranch: 'main' }
    })
    expect(result).not.toHaveProperty('localBaseRefRefresh.ownerWorktreePath')
  })

  // #15331: the relay proves the local branch absent (or current); there is nothing to report.
  it('reports no refresh status when the relay had nothing to do', async () => {
    const provider = createProvider({
      refresh: vi.fn().mockResolvedValue({ status: 'nothing_to_do' })
    })

    const result = await createWith(provider)

    expect(provider.refreshLocalBaseRefForWorktreeCreate).toHaveBeenCalledTimes(1)
    expect(result).not.toHaveProperty('localBaseRefRefresh')
  })

  it('keeps the not-fast-forward status the relay reports', async () => {
    const provider = createProvider({
      refresh: vi.fn().mockResolvedValue({ status: 'skipped_not_fast_forward' })
    })

    const result = await createWith(provider)

    expect(result).toMatchObject({
      localBaseRefRefresh: {
        status: 'skipped_not_fast_forward',
        baseRef: 'origin/main',
        localBranch: 'main'
      }
    })
  })
})

describe('SSH local base update suggestion on worktree create', () => {
  beforeEach(() => {
    setupWorktreeHandlers()
  })

  it('suggests an update from the relay inspection once the workspace root is registered', async () => {
    let registeredRoots = false
    const behind = vi.fn().mockImplementation(async () => {
      if (!registeredRoots) {
        throw new Error('Path outside authorized workspace')
      }
      return 4
    })
    const provider = createProvider({ behind })

    const result = await createWith(provider, {
      refreshSetting: false,
      worktreeBaseRef: 'refs/remotes/origin/main',
      registerRoot: () => (registeredRoots = true)
    })

    expect(behind).toHaveBeenCalledWith(REFS)
    expect(provider.refreshLocalBaseRefForWorktreeCreate).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      localBaseRefUpdateSuggestion: { baseRef: 'origin/main', localBranch: 'main', behind: 4 }
    })
  })

  it.each([
    ['cannot be fast-forwarded', async () => undefined],
    [
      'cannot be inspected',
      async () => {
        throw Object.assign(new Error('Method not found'), { code: -32601 })
      }
    ]
  ])('does not suggest an update when the local base %s', async (_case, inspect) => {
    const behind = vi.fn(inspect)
    const provider = createProvider({ behind })

    const result = await createWith(provider, {
      refreshSetting: false,
      worktreeBaseRef: 'refs/remotes/origin/main'
    })

    expect(behind).toHaveBeenCalledTimes(1)
    expect(result).not.toHaveProperty('localBaseRefUpdateSuggestion')
  })
})
