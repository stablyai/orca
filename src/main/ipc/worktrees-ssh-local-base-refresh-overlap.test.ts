import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSshGitProviderMock, getActiveMultiplexerMock } from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { SSH_MUX_REQUEST_TIMEOUT_CODE } from '../ssh/ssh-channel-multiplexer'

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
const REFRESH_UPDATED = { status: 'updated', ownerWorktreePath: '/remote/repo' }
const UPDATED = {
  status: 'updated',
  baseRef: 'origin/main',
  localBranch: 'main',
  ownerWorktreePath: '/remote/repo'
}

function createProvider(overrides: {
  refreshLocalBaseRefForWorktreeCreate: ReturnType<typeof vi.fn>
  addWorktree?: ReturnType<typeof vi.fn>
}) {
  return {
    exec: vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'show-ref') {
        throw Object.assign(new Error('missing remote ref'), { code: 1 })
      }
      return { stdout: '', stderr: '' }
    }),
    fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
    addWorktree: overrides.addWorktree ?? vi.fn().mockResolvedValue(undefined),
    listWorktrees: vi.fn().mockResolvedValue([
      {
        path: '/remote/repo-improve-dashboard',
        head: 'remote-main',
        branch: 'refs/heads/improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ]),
    worktreeIsClean: vi.fn().mockResolvedValue({ clean: true }),
    refreshLocalBaseRefForWorktreeCreate: overrides.refreshLocalBaseRefForWorktreeCreate
  }
}

async function createWith(
  provider: ReturnType<typeof createProvider>,
  request: { repo?: typeof REPO; name?: string } = {}
) {
  const repo = request.repo ?? REPO
  store.getSettings.mockReturnValue({
    branchPrefix: 'none',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: true,
    workspaceDir: '/workspace'
  })
  store.getRepos.mockReturnValue([repo])
  store.getRepo.mockReturnValue(repo)
  getSshGitProviderMock.mockReturnValue(provider)
  getActiveMultiplexerMock.mockReturnValue({
    request: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn()
  })
  store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)
  const result: unknown = await handlers['worktrees:create'](null, {
    repoId: 'repo-ssh',
    name: request.name ?? 'improve-dashboard'
  })
  return result
}

describe('SSH local base refresh failures', () => {
  beforeEach(() => {
    setupWorktreeHandlers()
  })

  // The relay may still finish the refresh; reporting it failed would be a guess.
  it.each([
    ['the request timed out', { code: SSH_MUX_REQUEST_TIMEOUT_CODE }],
    ['the connection was lost', { code: 'CONNECTION_LOST' }]
  ])('reports no refresh status when %s', async (_case, fields) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refresh = vi.fn(async () => {
      throw Object.assign(new Error('relay did not answer'), fields)
    })

    const result = await createWith(
      createProvider({ refreshLocalBaseRefForWorktreeCreate: refresh })
    )

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ worktree: expect.anything() })
    expect(result).not.toHaveProperty('localBaseRefRefresh')
    warn.mockRestore()
  })

  it('reports an error once, without retrying, when the relay rejects the refresh', async () => {
    const refresh = vi.fn(async () => {
      throw new Error('Invalid local base ref refresh refs.')
    })

    const result = await createWith(
      createProvider({ refreshLocalBaseRefForWorktreeCreate: refresh })
    )

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      localBaseRefRefresh: { status: 'skipped_error', baseRef: 'origin/main', localBranch: 'main' }
    })
  })
})

describe('SSH local base refresh overlap', () => {
  beforeEach(() => {
    setupWorktreeHandlers()
  })

  // #15331: `-b feature-x` proves there was no local feature-x to refresh; probing it would race the relay add.
  it('does not refresh or warn when the create makes the local base branch itself', async () => {
    const provider = createProvider({ refreshLocalBaseRefForWorktreeCreate: vi.fn() })
    provider.exec.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      // Only the remote-tracking base resolves; refs/heads/feature-x does not exist yet.
      const ref = args.at(-1) ?? ''
      return {
        stdout: args[0] === 'rev-parse' && ref.startsWith('refs/remotes/') ? 'remote-x\n' : '',
        stderr: ''
      }
    })
    provider.listWorktrees
      .mockReset()
      .mockResolvedValue([
        { path: '/remote/repo-feature-x', head: 'remote-x', branch: 'refs/heads/feature-x' }
      ])

    const result = await createWith(provider, {
      repo: { ...REPO, worktreeBaseRef: 'origin/feature-x' },
      name: 'feature-x'
    })

    expect(provider.addWorktree.mock.calls[0]?.[3]).toMatchObject({ base: 'origin/feature-x' })
    expect(provider.addWorktree).toHaveBeenCalledTimes(1)
    expect(provider.refreshLocalBaseRefForWorktreeCreate).not.toHaveBeenCalled()
    expect(result).not.toHaveProperty('localBaseRefRefresh')
  })

  it('starts the relay worktree add while the refresh is still running', async () => {
    let finishRefresh!: () => void
    let markRefreshStarted!: () => void
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    const refresh = vi.fn(
      () =>
        new Promise((resolve) => {
          finishRefresh = () => resolve(REFRESH_UPDATED)
          markRefreshStarted()
        })
    )
    // Would deadlock if create awaited the refresh before starting the add.
    const addWorktree = vi.fn(async () => {
      await refreshStarted
      finishRefresh()
    })

    const result = await createWith(
      createProvider({ refreshLocalBaseRefForWorktreeCreate: refresh, addWorktree })
    )

    expect(addWorktree).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ localBaseRefRefresh: UPDATED })
  })

  // The relay runs one refresh per branch host-side, so the app adds no queue of its own.
  it('hands every concurrent create straight to the relay', async () => {
    const settlers: (() => void)[] = []
    const refresh = vi.fn(
      () => new Promise((resolve) => settlers.push(() => resolve(REFRESH_UPDATED)))
    )
    const repos = [
      { repo: REPO, name: 'improve-dashboard' },
      { repo: REPO, name: 'fix-login' },
      { repo: { ...REPO, id: 'repo-ssh-other', path: '/remote/other' }, name: 'add-search' }
    ]
    const provider = createProvider({ refreshLocalBaseRefForWorktreeCreate: refresh })
    provider.listWorktrees.mockResolvedValue(
      repos.map(({ repo, name }) => ({
        path: `${repo.path}-${name}`,
        head: 'remote-main',
        branch: `refs/heads/${name}`
      }))
    )
    store.getSettings.mockReturnValue({
      branchPrefix: 'none',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: true,
      workspaceDir: '/workspace'
    })
    store.getRepos.mockReturnValue(repos.map(({ repo }) => repo))
    store.getRepo.mockImplementation((id: string) => repos.find((r) => r.repo.id === id)?.repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue({
      request: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    })
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    const results = repos.map(({ repo, name }) =>
      handlers['worktrees:create'](null, { repoId: repo.id, name })
    )

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(3))
    settlers.forEach((settle) => settle())
    for (const result of await Promise.all(results)) {
      expect(result).toMatchObject({ localBaseRefRefresh: { status: 'updated' } })
    }
  })
})
