import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addWorktreeMock,
  getActiveMultiplexerMock,
  getSshGitProviderMock,
  listWorktreesMock
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

const REMOTE_REPO_PATH = '/remote/repo'

function makeRepo(fields: Record<string, unknown>) {
  return {
    id: 'repo-1',
    path: REMOTE_REPO_PATH,
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    worktreeBaseRef: 'origin/main',
    ...fields
  }
}

function makeProvider(worktreePath: string) {
  return {
    exec: vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'show-ref') {
        // A hit here reads as "branch already exists"; the create loop would then rename.
        throw Object.assign(new Error('missing exact ref'), { code: 1 })
      }
      return { stdout: '', stderr: '' }
    }),
    fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
    addWorktree: vi.fn().mockResolvedValue(undefined),
    listWorktrees: vi.fn().mockResolvedValue([
      {
        path: worktreePath,
        head: 'abc123',
        branch: 'refs/heads/wt',
        isBare: false,
        isMainWorktree: false
      }
    ])
  }
}

function useRepo(repo: ReturnType<typeof makeRepo>): void {
  store.getRepos.mockReturnValue([repo])
  store.getRepo.mockReturnValue(repo)
  store.setWorktreeMeta.mockImplementation((_worktreeId: string, meta: unknown) => meta)
  getActiveMultiplexerMock.mockReturnValue({
    request: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn()
  })
}

describe('worktrees:create execution host routing', () => {
  beforeEach(() => {
    setupWorktreeHandlers()
  })

  it('creates on the SSH host for a row that names it only as executionHostId', async () => {
    // No `connectionId`: the raw read answered "local" and ran `git worktree add` on the client
    // against `/remote/repo`. The runtime sibling already resolved this row remotely.
    useRepo(makeRepo({ executionHostId: 'ssh:target-a' }))
    const provider = makeProvider('/remote/repo-wt')
    getSshGitProviderMock.mockImplementation((connectionId: string) =>
      connectionId === 'target-a' ? provider : undefined
    )

    await handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'wt' })

    expect(provider.addWorktree).toHaveBeenCalledTimes(1)
    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('keeps two simultaneously registered SSH hosts apart', async () => {
    useRepo(makeRepo({ executionHostId: 'ssh:target-b' }))
    const providerA = makeProvider('/remote/repo-wt-a')
    const providerB = makeProvider('/remote/repo-wt-b')
    getSshGitProviderMock.mockImplementation((connectionId: string) =>
      connectionId === 'target-a' ? providerA : connectionId === 'target-b' ? providerB : undefined
    )

    await handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'wt' })

    expect(providerB.addWorktree).toHaveBeenCalledTimes(1)
    expect(providerA.addWorktree).not.toHaveBeenCalled()
    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('refuses a runtime row with no nested SSH target instead of creating locally', async () => {
    useRepo(makeRepo({ executionHostId: 'runtime:env-1' }))

    await expect(
      handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'wt' })
    ).rejects.toThrow('not dispatched by this process')

    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('refuses a runtime row whose nested SSH target is dialable in this namespace', async () => {
    // `target-a` names a target inside env-1. A same-named one registered here is another machine,
    // so creating through it lands the checkout on the wrong host.
    useRepo(makeRepo({ executionHostId: 'runtime:env-1', connectionId: 'target-a' }))
    const provider = makeProvider('/remote/repo-wt')
    getSshGitProviderMock.mockImplementation((connectionId: string) =>
      connectionId === 'target-a' ? provider : undefined
    )

    await expect(
      handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'wt' })
    ).rejects.toThrow('not dispatched by this process')

    expect(provider.addWorktree).not.toHaveBeenCalled()
    expect(addWorktreeMock).not.toHaveBeenCalled()
  })

  it('answers local for a row that declares itself local while carrying a connection', async () => {
    // A contradictory row: `getRepoSshConnectionId` lets `local` win, and the runtime sibling has
    // always read it that way. The raw field sent it remote, so the two entry points disagreed.
    useRepo(
      makeRepo({ path: '/workspace/repo', executionHostId: 'local', connectionId: 'target-a' })
    )
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/wt',
        head: 'abc123',
        branch: 'wt',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const provider = makeProvider('/remote/repo-wt')
    getSshGitProviderMock.mockImplementation((connectionId: string) =>
      connectionId === 'target-a' ? provider : undefined
    )

    await handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'wt' })

    expect(addWorktreeMock).toHaveBeenCalledTimes(1)
    expect(provider.addWorktree).not.toHaveBeenCalled()
  })
})
