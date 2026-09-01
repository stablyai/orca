import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import { addWorktreeMock, listWorktreesMock } from './worktrees-test-module-mocks'
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

const REPO = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}
const WORKTREE_ID = 'repo-1::/workspace/improve-dashboard'
const AGENT_LAUNCH = { kind: 'fresh' as const, agent: 'claude' as const }

describe('desktop worktrees:create agent launch', () => {
  let runtimeStub: WorktreeRuntimeStub

  beforeEach(() => {
    runtimeStub = setupWorktreeHandlers()
    store.getRepo.mockReturnValue(REPO)
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/improve-dashboard',
        head: 'abc123',
        branch: 'improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])
  })

  function create(): Promise<CreateWorktreeResult> {
    return handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      agentLaunch: AGENT_LAUNCH
    }) as Promise<CreateWorktreeResult>
  }

  // The desktop IPC path used to hand `createArgs` to the create helpers and
  // never read `agentLaunch`, so the workspace appeared with no agent and no
  // error — the renderer sets `hostOwnedLaunch` and never spawns one itself.
  it('spawns the host-owned agent terminal after the worktree is created', async () => {
    const finish = vi.fn()
    runtimeStub.prepareLocalWorktreeCreateAgentLaunch.mockResolvedValue({
      ok: true,
      release: vi.fn(),
      finish
    })
    runtimeStub.finishLocalWorktreeCreateAgentLaunch.mockResolvedValue({
      agentLaunchResult: { status: 'launched', receipt: { launchToken: 'tok-1' } },
      startupTerminal: { spawned: true, handle: 'term-agent', surface: 'background' }
    })

    const result = await create()

    expect(runtimeStub.prepareLocalWorktreeCreateAgentLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1' }),
      AGENT_LAUNCH
    )
    expect(runtimeStub.finishLocalWorktreeCreateAgentLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true }),
      WORKTREE_ID,
      { repoPath: '/workspace/repo', worktreePath: '/workspace/improve-dashboard' },
      undefined
    )
    expect(result).toMatchObject({
      startupTerminal: { spawned: true, handle: 'term-agent' },
      agentLaunchResult: { status: 'launched' }
    })
  })

  // Stage 1 runs before git so a capacity/identity rejection leaves no workspace.
  it('creates no worktree when the launch is rejected before git', async () => {
    runtimeStub.prepareLocalWorktreeCreateAgentLaunch.mockResolvedValue({
      ok: false,
      requestError: { code: 'agent_not_found' }
    })

    const result = await create()

    expect(result).toEqual({
      created: false,
      agentLaunchResult: { status: 'rejected', requestError: { code: 'agent_not_found' } }
    })
    expect(addWorktreeMock).not.toHaveBeenCalled()
    expect(runtimeStub.finishLocalWorktreeCreateAgentLaunch).not.toHaveBeenCalled()
  })

  // A leaked reservation burns launch capacity for the rest of the session.
  it('releases the reservation when git itself fails', async () => {
    const release = vi.fn()
    runtimeStub.prepareLocalWorktreeCreateAgentLaunch.mockResolvedValue({
      ok: true,
      release,
      finish: vi.fn()
    })
    addWorktreeMock.mockRejectedValueOnce(new Error('git exploded'))

    await expect(create()).rejects.toThrow('git exploded')

    expect(release).toHaveBeenCalledTimes(1)
    expect(runtimeStub.finishLocalWorktreeCreateAgentLaunch).not.toHaveBeenCalled()
  })
})
