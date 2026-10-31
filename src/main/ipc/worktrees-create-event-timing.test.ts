import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addWorktreeMock,
  gitExecFileAsyncMock,
  listWorktreesMock,
  setPlatform
} from './worktrees-test-module-mocks'
import { handlers, mainWindow, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { beginPreparationWork } from '../worktree-create-concurrency'
import { addWorktree } from '../git/worktree'

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
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
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
vi.mock('./pty/provider/registry', async () =>
  (await import('./worktrees-test-module-mocks')).ptyRegistryModuleMock()
)
vi.mock('./pty/provider/state-cleanup', async () =>
  (await import('./worktrees-test-module-mocks')).ptyStateCleanupModuleMock()
)

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
  store.setWorktreeMeta.mockImplementation((_target: unknown, meta: unknown) => meta)
}

function useLocalListing(): void {
  listWorktreesMock.mockResolvedValue([
    { path: '/workspace/repo', head: 'abc', branch: 'main', isBare: false, isMainWorktree: true },
    { path: '/workspace/wt', head: 'abc123', branch: 'wt', isBare: false, isMainWorktree: false }
  ])
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

    // Create has answered while the hook probe still delays telemetry.
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
    expect(trackedEvents('workspace_created')).toHaveLength(1)
    expect(trackedEvents('workspace_create_failed')).toHaveLength(0)
    expect(typeof props?.total_ms).toBe('number')
    expect(typeof props?.git_worktree_add_ms).toBe('number')
    expect(props).toHaveProperty('prepared_checkout')
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

  it('refuses an SSH create and still names its host on the failed event', async () => {
    useRepo(makeRepo({ path: '/remote/repo', executionHostId: 'ssh:target-a' }))

    await expect(
      handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'wt' })
    ).rejects.toThrow('Remote connection dropped')

    expect(addWorktreeMock).not.toHaveBeenCalled()
    expect(probeHookMock).not.toHaveBeenCalled()
    expect(trackedEvent('workspace_create_failed')).toMatchObject({ execution_host: 'ssh' })
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

describe('worktrees:create checkout progress event', () => {
  beforeEach(() => {
    setupWorktreeHandlers()
  })

  it("forwards git's checkout meter to the pending create it belongs to", async () => {
    useRepo(makeRepo({}))
    useLocalListing()
    await handlers['worktrees:create'](null, { repoId: 'repo-1', name: 'wt', creationId: 'c-7' })
    const onCheckoutProgress = vi.mocked(addWorktree).mock.calls.at(-1)?.[6]?.onCheckoutProgress
    vi.mocked(mainWindow.webContents.send).mockClear()

    onCheckoutProgress?.({ percent: 42, completed: 420, total: 1000 })
    onCheckoutProgress?.(null)

    expect(vi.mocked(mainWindow.webContents.send).mock.calls).toEqual([
      [
        'createWorktree:progress',
        {
          creationId: 'c-7',
          phase: 'creating',
          checkout: { percent: 42, completed: 420, total: 1000 }
        }
      ],
      ['createWorktree:progress', { creationId: 'c-7', phase: 'creating', checkout: null }]
    ])
  })
})
