import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addWorktreeMock,
  getActiveMultiplexerMock,
  getSshGitProviderMock,
  gitExecFileAsyncMock,
  listWorktreesMock,
  setPlatform
} from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { beginPreparationWork } from '../worktree-create-concurrency'

const { trackMock, probeHookMock, telemetryEnabledMock } = vi.hoisted(() => ({
  trackMock: vi.fn<(name: string, props: Record<string, unknown>) => void>(),
  probeHookMock: vi.fn(),
  telemetryEnabledMock: vi.fn(() => true)
}))

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

vi.mock('../telemetry/client', () => ({
  track: trackMock,
  isTelemetryEnabled: telemetryEnabledMock
}))
vi.mock('../git/create-event-repo-probe', () => ({
  probeCreateEventRepoFacts: probeHookMock
}))

function makeRepo(fields: Record<string, unknown>) {
  return {
    id: 'repo-1',
    path: '/workspace/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    worktreeBaseRef: 'origin/main',
    ...fields
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

function useLocalListing(): void {
  listWorktreesMock.mockResolvedValue([
    { path: '/workspace/repo', head: 'abc', branch: 'main', isBare: false, isMainWorktree: true },
    { path: '/workspace/wt', head: 'abc123', branch: 'wt', isBare: false, isMainWorktree: false }
  ])
}

function useSshProvider() {
  useRepo(makeRepo({ path: '/remote/repo', executionHostId: 'ssh:target-a' }))
  const provider = {
    exec: vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'show-ref') {
        throw Object.assign(new Error('missing exact ref'), { code: 1 })
      }
      return { stdout: '', stderr: '' }
    }),
    fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
    addWorktree: vi.fn().mockResolvedValue(undefined),
    listWorktrees: vi.fn().mockResolvedValue([
      {
        path: '/remote/repo-wt',
        head: 'abc',
        branch: 'refs/heads/wt',
        isBare: false,
        isMainWorktree: false
      }
    ])
  }
  getSshGitProviderMock.mockImplementation((connectionId: string) =>
    connectionId === 'target-a' ? provider : undefined
  )
  return provider
}

function trackedEvents(name: string): Record<string, unknown>[] {
  return trackMock.mock.calls.filter(([eventName]) => eventName === name).map(([, props]) => props)
}

function trackedEvent(name: string): Record<string, unknown> | undefined {
  const call = trackMock.mock.calls.find(([eventName]) => eventName === name)
  return call?.[1]
}

function gitWorkCallCount(): number {
  return (
    gitExecFileAsyncMock.mock.calls.length +
    addWorktreeMock.mock.calls.length +
    listWorktreesMock.mock.calls.length
  )
}

describe('worktrees:create event timing fields', () => {
  beforeEach(() => {
    setupWorktreeHandlers()
    trackMock.mockReset()
    probeHookMock.mockReset()
    telemetryEnabledMock.mockReset()
    telemetryEnabledMock.mockReturnValue(true)
  })

  it('sends timing after the create returns, without any further git work', async () => {
    useRepo(makeRepo({}))
    useLocalListing()
    let resolveProbe: (value: {
      postCheckoutHook: string
      indexEntryCount?: number
    }) => void = () => {}
    probeHookMock.mockReturnValue(
      new Promise((resolve) => {
        resolveProbe = resolve
      })
    )

    await handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'wt' })

    // The create already answered; the hook probe has not, so the event is not sent yet.
    expect(trackedEvent('workspace_created')).toBeUndefined()
    const gitCallsAtReturn = gitWorkCallCount()

    resolveProbe({ postCheckoutHook: 'present', indexEntryCount: 6_000 })
    await vi.waitFor(() => expect(trackedEvent('workspace_created')).toBeDefined())

    expect(gitWorkCallCount()).toBe(gitCallsAtReturn)
    expect(probeHookMock).toHaveBeenCalledWith('/workspace/repo')
    const props = trackedEvent('workspace_created')
    expect(props).toMatchObject({
      source: 'unknown',
      from_existing_branch: false,
      create_entry_point: 'app',
      execution_host: 'local',
      worktree_count_bucket: '2-5',
      concurrent_creates: 0,
      concurrent_preparations: 0,
      repo_file_count_bucket: '1k-10k',
      post_checkout_hook: 'present'
    })
    // One create, one event: the runtime entry point never runs for an app create.
    expect(trackedEvents('workspace_created')).toHaveLength(1)
    expect(trackedEvents('workspace_create_failed')).toHaveLength(0)
    expect(typeof props?.total_ms).toBe('number')
    expect(typeof props?.git_worktree_add_ms).toBe('number')
    expect(props).toHaveProperty('prepared_checkout')
    // Nothing that names the repo, the branch or a path rides along.
    expect(JSON.stringify(props)).not.toMatch(/workspace|wt|repo-1/)
  })

  it('counts prepared-checkout work that ran alongside the create', async () => {
    useRepo(makeRepo({}))
    useLocalListing()
    probeHookMock.mockResolvedValue({ postCheckoutHook: 'absent' })
    const build = beginPreparationWork()

    await handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'wt' })
    build.end()
    await vi.waitFor(() => expect(trackedEvent('workspace_created')).toBeDefined())

    expect(trackedEvent('workspace_created')).toMatchObject({ concurrent_preparations: 1 })
  })

  it('still answers the create, or its error, when sending the event throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    useRepo(makeRepo({}))
    useLocalListing()
    probeHookMock.mockResolvedValue({ postCheckoutHook: 'absent' })
    trackMock.mockImplementation(() => {
      throw new Error('telemetry broke')
    })

    await expect(
      handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'wt' })
    ).resolves.toHaveProperty('worktree')

    addWorktreeMock.mockRejectedValue(new Error('fatal: could not create work tree dir'))
    await expect(
      handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'wt' })
    ).rejects.toThrow('could not create work tree dir')
  })

  it('does not read the repo for hooks when telemetry is off', async () => {
    useRepo(makeRepo({}))
    useLocalListing()
    telemetryEnabledMock.mockReturnValue(false)

    await handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'wt' })
    await vi.waitFor(() => expect(trackedEvent('workspace_created')).toBeDefined())

    expect(probeHookMock).not.toHaveBeenCalled()
    expect(trackedEvent('workspace_created')).not.toHaveProperty('post_checkout_hook')
  })

  it.each([
    { repoPath: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', host: 'wsl' },
    { repoPath: '/workspace/repo', host: 'local' }
  ])(
    'labels $repoPath as $host from where Git runs, with no WSL project runtime',
    async ({ repoPath, host }) => {
      setPlatform('win32')
      useRepo(makeRepo({ path: repoPath }))
      useLocalListing()
      probeHookMock.mockResolvedValue({ postCheckoutHook: 'absent' })

      await handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'wt' })
      await vi.waitFor(() => expect(trackedEvent('workspace_created')).toBeDefined())

      expect(trackedEvent('workspace_created')).toMatchObject({ execution_host: host })
    }
  )

  it('records an SSH create without probing the remote for hooks', async () => {
    useSshProvider()

    await handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'wt' })
    await vi.waitFor(() => expect(trackedEvent('workspace_created')).toBeDefined())

    expect(probeHookMock).not.toHaveBeenCalled()
    const props = trackedEvent('workspace_created')
    expect(props).toMatchObject({ execution_host: 'ssh', worktree_count_bucket: '1' })
    expect(props).not.toHaveProperty('post_checkout_hook')
    expect(props).not.toHaveProperty('prepared_checkout')
  })

  it('attributes an old-relay SSH add error to the add through its cause', async () => {
    const provider = useSshProvider()
    provider.addWorktree.mockRejectedValue(new Error('Path outside authorized workspace: /x'))

    let caught: unknown
    try {
      await handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'wt' })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught instanceof Error && caught.message).toMatch(/^Older relay reported/)
    expect(caught instanceof Error && caught.cause).toBeInstanceOf(Error)
    expect(trackedEvent('workspace_create_failed')).toMatchObject({
      failed_phase: 'git_worktree_add',
      execution_host: 'ssh'
    })
  })

  it('names the phase a failed create died in', async () => {
    useRepo(makeRepo({}))
    useLocalListing()
    addWorktreeMock.mockRejectedValue(new Error('fatal: could not create work tree dir'))

    await expect(
      handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'wt' })
    ).rejects.toThrow()

    const props = trackedEvent('workspace_create_failed')
    expect(props).toMatchObject({
      failed_phase: 'git_worktree_add',
      create_entry_point: 'app',
      execution_host: 'local',
      concurrent_creates: 0,
      concurrent_preparations: 0,
      prepared_checkout: 'miss',
      prepared_checkout_miss_reason: 'none_armed'
    })
    expect(trackedEvents('workspace_create_failed')).toHaveLength(1)
    expect(trackedEvents('workspace_created')).toHaveLength(0)
    expect(typeof props?.total_ms).toBe('number')
    expect(JSON.stringify(props)).not.toMatch(/fatal|work tree/)
  })
})
