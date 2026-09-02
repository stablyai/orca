import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  setPlatform,
  listWorktreesMock,
  assertWorktreeCleanForRemovalMock,
  addWorktreeMock,
  removeWorktreeMock,
  resolveDefaultBaseRefWithLocalGitMock,
  getDefaultRemoteMock,
  getBranchConflictKindMock,
  getPRForBranchMock,
  getEffectiveHooksMock,
  createSetupRunnerScriptMock,
  getEffectiveHooksFromConfigMock,
  shouldRunSetupForCreateMock,
  getBaseRefDefaultMock,
  gitExecFileAsyncMock
} from './worktrees-test-module-mocks'
import { handlers, harnessRepo, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { materializeWorktreePushTargetRemote } from './worktree-remote'
import type { WorktreeRuntimeStub } from './worktrees-test-runtime-stub'
import {
  createdWorktreeList,
  mockKnownFeatureWorktree,
  mockSelectedWslProjectRuntime
} from './worktrees-test-fixtures'

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

/** Every create-path git call, including the base-ref probe now shared with the
 *  speculative prefetch, must read the distro's ref store rather than host git's. */
function expectEveryGitCallRoutedTo(wslDistro: string): void {
  const callDistros = new Set(
    gitExecFileAsyncMock.mock.calls.map(
      ([, options]) => (options as { wslDistro?: string } | undefined)?.wslDistro
    )
  )
  expect(callDistros).toEqual(new Set([wslDistro]))
}

describe('registerWorktreeHandlers', () => {
  let runtimeStub: WorktreeRuntimeStub

  beforeEach(() => {
    runtimeStub = setupWorktreeHandlers()
  })

  it('routes the speculative create-base prefetch through the selected WSL project runtime', async () => {
    mockSelectedWslProjectRuntime()
    const remoteTrackingBase = {
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    }
    runtimeStub.resolveRemoteTrackingBase.mockResolvedValue(remoteTrackingBase)

    await handlers['worktrees:prefetchCreateBase'](null, { repoId: 'repo-1' })

    expect(getBaseRefDefaultMock).toHaveBeenCalledWith('/workspace/repo', { wslDistro: 'Ubuntu' })
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'],
      { cwd: '/workspace/repo', wslDistro: 'Ubuntu' }
    )
    expect(runtimeStub.resolveRemoteTrackingBase).toHaveBeenCalledWith(
      '/workspace/repo',
      'origin/main',
      { wslDistro: 'Ubuntu' }
    )
    expect(runtimeStub.getOrStartRemoteTrackingBaseRefresh).toHaveBeenCalledWith(
      '/workspace/repo',
      remoteTrackingBase,
      { wslDistro: 'Ubuntu' }
    )
  })

  it('routes the prefetch remote-fetch fallback through the selected WSL project runtime', async () => {
    mockSelectedWslProjectRuntime()
    runtimeStub.resolveRemoteTrackingBase.mockResolvedValue(null)

    await handlers['worktrees:prefetchCreateBase'](null, {
      repoId: 'repo-1',
      baseBranch: 'feature/topic'
    })

    expect(runtimeStub.fetchRemoteWithCache).toHaveBeenCalledWith('/workspace/repo', 'origin', {
      wslDistro: 'Ubuntu'
    })
  })

  it('routes local worktree creation through the selected WSL project runtime', async () => {
    mockSelectedWslProjectRuntime()
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/repo',
        head: 'base',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '/workspace/improve-dashboard',
        head: 'abc123',
        branch: 'refs/heads/improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })

    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/improve-dashboard',
      'improve-dashboard',
      'origin/main',
      false,
      false,
      { wslDistro: 'Ubuntu' }
    )
    expect(resolveDefaultBaseRefWithLocalGitMock).toHaveBeenCalledWith({
      cwd: '/workspace/repo',
      wslDistro: 'Ubuntu'
    })
    expect(getBranchConflictKindMock).toHaveBeenCalledWith(
      '/workspace/repo',
      'improve-dashboard',
      'origin/main',
      { wslDistro: 'Ubuntu' }
    )
    expect(listWorktreesMock).toHaveBeenCalledWith('/workspace/repo', { wslDistro: 'Ubuntu' })
    expectEveryGitCallRoutedTo('Ubuntu')
  })

  it('routes local worktree creation with a remote tracking base through the selected WSL project runtime', async () => {
    mockSelectedWslProjectRuntime()
    runtimeStub.resolveRemoteTrackingBase.mockResolvedValue({
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    })
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'abc123\n', stderr: '' })
    // A persisted base that differs from the detected default also drives the usability probe.
    store.getRepo.mockReturnValue({ ...harnessRepo, worktreeBaseRef: 'custom-base' })
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard',
        head: 'abc123',
        branch: 'refs/heads/improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })

    expectEveryGitCallRoutedTo('Ubuntu')
  })

  // Was "routes fork push target setup ... through create": create used to mint the
  // fork remote (and route it to the selected WSL distro) unconditionally. It now
  // defers to first sync (#17828) -- split in two so each half stays true to a single
  // claim: create stays a no-op even for a WSL-routed repo, sync still routes to the distro.
  it('does not mint a fork remote at create time for a WSL-routed worktree', async () => {
    mockSelectedWslProjectRuntime()
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/wsl-fork',
        head: 'abc123',
        branch: 'refs/heads/wsl-fork',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'wsl-fork',
      pushTarget: {
        remoteName: 'pr-contributor-orca',
        branchName: 'contributor/wsl-fork',
        remoteUrl: 'git@github.com:contributor/orca.git'
      }
    })

    const calls = gitExecFileAsyncMock.mock.calls.map((call) => call[0] as string[])
    expect(calls).not.toContainEqual(['check-ref-format', '--branch', 'contributor/wsl-fork'])
    expect(calls.some((args) => args[0] === 'remote' && args[1] === 'add')).toBe(false)
    expect(calls.some((args) => args[0] === 'fetch')).toBe(false)
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        pushTarget: {
          remoteName: 'pr-contributor-orca',
          branchName: 'contributor/wsl-fork',
          remoteUrl: 'git@github.com:contributor/orca.git'
        }
      })
    )
  })

  // Companion to the deferral test above: `materializeWorktreePushTargetRemote` is
  // exactly what `git:push`/`git:pull`'s local dispatch calls (with the repo's resolved
  // wslDistro) before syncing, so this is "first sync" without needing that IPC handler
  // registered in this harness.
  it('routes fork push target materialization through the selected WSL project runtime', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    const target = {
      remoteName: 'pr-contributor-orca',
      branchName: 'contributor/wsl-fork',
      remoteUrl: 'git@github.com:contributor/orca.git'
    }

    const result = await materializeWorktreePushTargetRemote(
      '/workspace/repo',
      target,
      undefined,
      undefined,
      { wslDistro: 'Ubuntu' }
    )

    expect(result).toEqual({ ...target, remoteCreated: true })
    const wslRoutingOptions = { cwd: '/workspace/repo', wslDistro: 'Ubuntu' }
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['check-ref-format', '--branch', 'contributor/wsl-fork'],
      wslRoutingOptions
    )
    // Mint: `-t <branch> --no-tags` (see #17828) keeps the remote's own default off the
    // wide wildcard, then `ensureRemoteTracksBranchNarrowly` rewrites it to the trailing-`*`
    // form immediately after -- both routed through the same WSL project runtime.
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'remote',
        'add',
        '-t',
        'contributor/wsl-fork',
        '--no-tags',
        'pr-contributor-orca',
        'git@github.com:contributor/orca.git'
      ],
      wslRoutingOptions
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['config', '--get-all', 'remote.pr-contributor-orca.fetch'],
      wslRoutingOptions
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'config',
        '--add',
        'remote.pr-contributor-orca.fetch',
        '+refs/heads/contributor/wsl-fork*:refs/remotes/pr-contributor-orca/contributor/wsl-fork*'
      ],
      wslRoutingOptions
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['config', 'remote.pr-contributor-orca.tagOpt', '--no-tags'],
      wslRoutingOptions
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['config', 'remote.pr-contributor-orca.orca-created', 'true'],
      wslRoutingOptions
    )
    // Why: the mint's fetch is the one call in this sequence that talks to the network --
    // bounded the same as the deferred short-circuit's fetch (see DEFERRED_PUSH_TARGET_FETCH_TIMEOUT_MS)
    // so a hung credential prompt can't wedge it forever. Every other call here is local-only
    // and stays untimed, per `wslRoutingOptions` above.
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'fetch',
        'pr-contributor-orca',
        '+refs/heads/contributor/wsl-fork*:refs/remotes/pr-contributor-orca/contributor/wsl-fork*'
      ],
      { ...wslRoutingOptions, timeout: expect.any(Number) }
    )
    // wslDistro threaded through every subprocess this materialize made, not just the adds.
    const distros = new Set(
      gitExecFileAsyncMock.mock.calls.map(
        ([, options]) => (options as { wslDistro?: string } | undefined)?.wslDistro
      )
    )
    expect(distros).toEqual(new Set(['Ubuntu']))
  })

  it('routes selected PR branch conflict lookup through the selected WSL project runtime', async () => {
    mockSelectedWslProjectRuntime()
    getBranchConflictKindMock.mockResolvedValueOnce('remote')
    getPRForBranchMock.mockResolvedValueOnce({
      number: 42,
      title: 'Selected PR',
      state: 'open',
      url: 'https://example.com/pr/42',
      checksStatus: 'success',
      updatedAt: '2026-06-16T00:00:00.000Z',
      mergeable: 'UNKNOWN'
    })
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/fix-title',
        head: 'abc123',
        branch: 'refs/heads/feature/fix',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'fix-title',
      baseBranch: 'abc123',
      branchNameOverride: 'feature/fix',
      linkedPR: 42,
      pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
    })

    expect(getPRForBranchMock).toHaveBeenCalledWith(
      '/workspace/repo',
      'feature/fix',
      null,
      null,
      null,
      { localGitExecOptions: { wslDistro: 'Ubuntu' } }
    )
    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/fix-title',
      'feature/fix',
      'abc123',
      false,
      false,
      { wslDistro: 'Ubuntu' }
    )
  })

  it('routes PR base git calls through the selected WSL project runtime', async () => {
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
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        return { stdout: 'def456\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await handlers['worktrees:resolvePrBase'](null, {
      repoId: 'repo-1',
      prNumber: 42,
      headRefName: 'feature/add-feature',
      isCrossRepository: false
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'fetch',
        'origin',
        '+refs/heads/feature/add-feature:refs/remotes/origin/feature/add-feature'
      ],
      { cwd: '/workspace/repo', wslDistro: 'Ubuntu' }
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rev-parse', '--verify', 'origin/feature/add-feature'],
      { cwd: '/workspace/repo', wslDistro: 'Ubuntu' }
    )
    expect(getDefaultRemoteMock).toHaveBeenCalledWith('/workspace/repo', { wslDistro: 'Ubuntu' })
    expect(result).toMatchObject({
      baseBranch: 'def456',
      headSha: 'def456',
      branchNameOverride: 'feature/add-feature',
      pushTarget: { remoteName: 'origin', branchName: 'feature/add-feature' }
    })
  })

  it('lists detected worktrees through the selected WSL project runtime', async () => {
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
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/repo',
        head: 'def456',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ])

    const result = await handlers['worktrees:listDetected'](null, { repoId: 'repo-1' })

    expect(listWorktreesMock).toHaveBeenCalledWith('/workspace/repo', { wslDistro: 'Ubuntu' })
    expect(result).toMatchObject({
      repoId: 'repo-1',
      authoritative: true,
      source: 'git',
      worktrees: [expect.objectContaining({ path: '/workspace/repo' })]
    })
  })

  it('routes setup runner generation through the selected WSL project runtime', async () => {
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
    listWorktreesMock.mockResolvedValue(createdWorktreeList)
    getEffectiveHooksMock.mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    getEffectiveHooksFromConfigMock.mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    shouldRunSetupForCreateMock.mockReturnValue(true)

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      setupDecision: 'run'
    })

    expect(createSetupRunnerScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1' }),
      '/workspace/improve-dashboard',
      'pnpm worktree:setup',
      { wslDistro: 'Ubuntu' },
      undefined,
      undefined
    )
    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/improve-dashboard',
      'improve-dashboard',
      'origin/main',
      false,
      false,
      { wslDistro: 'Ubuntu' }
    )
  })

  it('routes local worktree removal through the selected WSL project runtime', async () => {
    mockSelectedWslProjectRuntime()
    mockKnownFeatureWorktree()
    getEffectiveHooksMock.mockReturnValue(null)
    removeWorktreeMock.mockResolvedValue({})

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    expect(listWorktreesMock).toHaveBeenCalledWith('/workspace/repo', { wslDistro: 'Ubuntu' })
    expect(assertWorktreeCleanForRemovalMock).toHaveBeenCalledWith('/workspace/feature-wt', false, {
      wslDistro: 'Ubuntu'
    })
    expect(removeWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/feature-wt',
      false,
      expect.objectContaining({ wslDistro: 'Ubuntu' })
    )
  })

  it('surfaces selected-runtime list failures during local worktree removal', async () => {
    mockSelectedWslProjectRuntime()
    const listError = new Error('wsl git list failed')
    listWorktreesMock.mockRejectedValue(listError)

    await expect(
      handlers['worktrees:remove'](null, {
        worktreeId: 'repo-1::/workspace/feature-wt'
      })
    ).rejects.toThrow('wsl git list failed')

    expect(listWorktreesMock).toHaveBeenCalledWith('/workspace/repo', { wslDistro: 'Ubuntu' })
    expect(assertWorktreeCleanForRemovalMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
  })
})
