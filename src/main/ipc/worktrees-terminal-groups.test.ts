import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listWorktreesMock,
  addWorktreeMock,
  removeWorktreeMock,
  getLocalPtyProviderMock,
  killAllProcessesForWorktreeMock,
  clearProviderPtyStateMock
} from './worktrees-test-module-mocks'
import {
  handlers,
  ipcEvent,
  mainWindow,
  setupWorktreeHandlers,
  store
} from './worktrees-test-harness'
import type { WorktreeRuntimeStub } from './worktrees-test-runtime-stub'
import type { ProviderRequestId } from '../../shared/detected-worktree-provider-contract'
import type { Worktree } from '../../shared/worktree/types'

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

describe('git project terminal groups', () => {
  let runtimeStub: WorktreeRuntimeStub

  beforeEach(() => {
    runtimeStub = setupWorktreeHandlers()
  })

  function makeWorktreeMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      displayName: '',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      ...overrides
    }
  }

  it('creates a terminal group on a git repo without git worktree add', async () => {
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) =>
      makeWorktreeMeta(meta as Record<string, unknown>)
    )

    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'servers',
      terminalGroup: true,
      createdWithAgent: 'codex'
    })) as { worktree: Worktree }

    expect(addWorktreeMock).not.toHaveBeenCalled()
    expect(result.worktree).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^repo-1::\/workspace\/repo::workspace:[0-9a-f-]{36}$/),
        repoId: 'repo-1',
        // The group runs in the project checkout, so it has no branch and no worktree of its own.
        path: '/workspace/repo',
        branch: '',
        head: '',
        isMainWorktree: false,
        displayName: 'servers',
        createdWithAgent: 'codex'
      })
    )
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: 'repo-1'
    })
  })

  it('lists a git repo terminal group alongside its checkouts', async () => {
    const terminalGroupId =
      'repo-1::/workspace/repo::workspace:11111111-1111-4111-8111-111111111111'
    const meta = makeWorktreeMeta({
      instanceId: '11111111-1111-4111-8111-111111111111',
      projectId: 'repo:repo-1',
      hostId: 'local',
      projectHostSetupId: 'repo-1',
      displayName: 'servers',
      orcaCreatedAt: 5,
      createdAt: 5
    })
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/repo',
        head: 'abc',
        branch: 'main',
        isBare: false,
        isMainWorktree: true
      }
    ])
    store.getAllWorktreeMeta.mockReturnValue({ [terminalGroupId]: meta })
    store.getWorktreeMeta.mockImplementation((worktreeId: string) =>
      worktreeId === terminalGroupId ? meta : undefined
    )

    const listed = (await handlers['worktrees:list'](null, { repoId: 'repo-1' })) as Worktree[]

    expect(listed).toEqual([
      expect.objectContaining({ id: 'repo-1::/workspace/repo', branch: 'main' }),
      expect.objectContaining({
        id: terminalGroupId,
        repoId: 'repo-1',
        path: '/workspace/repo',
        displayName: 'servers',
        branch: '',
        head: '',
        isMainWorktree: false
      })
    ])
  })

  it('keeps a terminal group in the detected listing, which purges every id it omits', async () => {
    const terminalGroupId =
      'repo-1::/workspace/repo::workspace:22222222-2222-4222-8222-222222222222'
    const meta = makeWorktreeMeta({
      instanceId: '22222222-2222-4222-8222-222222222222',
      projectId: 'repo:repo-1',
      hostId: 'local',
      projectHostSetupId: 'repo-1',
      displayName: 'research',
      orcaCreatedAt: 5
    })
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/repo',
        head: 'abc',
        branch: 'main',
        isBare: false,
        isMainWorktree: true
      }
    ])
    store.getAllWorktreeMeta.mockReturnValue({ [terminalGroupId]: meta })
    store.getWorktreeMeta.mockImplementation((worktreeId: string) =>
      worktreeId === terminalGroupId ? meta : undefined
    )

    const result = (await handlers['worktrees:listDetected'](ipcEvent, {
      providerRequestId: 'request-1' as ProviderRequestId,
      repoId: 'repo-1',
      executionHostId: 'local'
    })) as { result: { authoritative: boolean; worktrees: { id: string; visible: boolean }[] } }

    expect(result.result.authoritative).toBe(true)
    expect(result.result.worktrees).toContainEqual(
      expect.objectContaining({ id: terminalGroupId, visible: true })
    )
  })

  // A terminal group's path IS the project checkout, so routing it down the git removal path would
  // run `git worktree remove` (or an orphan-directory cleanup) against the user's main clone.
  it('removes a git repo terminal group without touching git or disk', async () => {
    const ptyProvider = {} as never
    const worktreeId = 'repo-1::/workspace/repo::workspace:33333333-3333-4333-8333-333333333333'
    getLocalPtyProviderMock.mockReturnValue(ptyProvider)

    await handlers['worktrees:remove'](null, { worktreeId })

    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(listWorktreesMock).not.toHaveBeenCalled()
    expect(killAllProcessesForWorktreeMock).toHaveBeenCalledWith(worktreeId, {
      runtime: runtimeStub,
      resolvedWorktreeId: worktreeId,
      localProvider: ptyProvider,
      onPtyStopped: clearProviderPtyStateMock
    })
    expect(killAllProcessesForWorktreeMock.mock.invocationCallOrder[0]).toBeLessThan(
      store.removeWorktreeMeta.mock.invocationCallOrder[0]
    )
    expect(store.removeWorktreeMeta).toHaveBeenCalledWith(worktreeId, 'local')
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: 'repo-1'
    })
  })
})
