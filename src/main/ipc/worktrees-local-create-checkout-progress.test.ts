import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddWorktreeOptions } from '../git/worktree'
import type * as WorktreeLogic from './worktree-logic'
import type * as WorktreeCreatePreparation from '../worktree-create-preparation'
import { consumePreparedWorktreeCreate } from '../worktree-create-preparation'
import { addWorktreeMock, listWorktreesMock } from './worktrees-test-module-mocks'
import { handlers, mainWindow, setupWorktreeHandlers } from './worktrees-test-harness'

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
vi.mock('./worktree-logic', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeLogic>()
  return {
    ...(await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(actual),
    computeWorkspaceRootAsync: vi.fn(actual.computeWorkspaceRootAsync)
  }
})
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
vi.mock('../worktree-create-preparation', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeCreatePreparation>()
  return {
    ...actual,
    consumePreparedWorktreeCreate: vi.fn(actual.consumePreparedWorktreeCreate)
  }
})

describe('local create checkout progress', () => {
  beforeEach(() => {
    setupWorktreeHandlers()
  })

  async function create(name: string, creationId?: string): Promise<void> {
    listWorktreesMock.mockResolvedValue([
      {
        path: `/workspace/${name}`,
        head: 'abc123',
        branch: name,
        isBare: false,
        isMainWorktree: false
      }
    ])
    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name,
      ...(creationId ? { creationId } : {})
    })
  }

  function lastAddOptions(): AddWorktreeOptions {
    const call = addWorktreeMock.mock.calls.at(-1)
    expect(call).toBeDefined()
    return call?.at(-1) ?? {}
  }

  it("forwards git's checkout meter to the pending create it belongs to", async () => {
    await create('progress-feature', 'creation-7')
    const { onCheckoutProgress } = lastAddOptions()
    expect(onCheckoutProgress).toBeTypeOf('function')
    vi.mocked(mainWindow.webContents.send).mockClear()

    onCheckoutProgress?.({ percent: 42, completed: 420, total: 1000 })
    onCheckoutProgress?.(null)

    expect(vi.mocked(mainWindow.webContents.send).mock.calls).toEqual([
      [
        'createWorktree:progress',
        {
          creationId: 'creation-7',
          phase: 'creating',
          checkout: { percent: 42, completed: 420, total: 1000 }
        }
      ],
      ['createWorktree:progress', { creationId: 'creation-7', phase: 'creating', checkout: null }]
    ])
  })

  it('attaches no progress reader when no pending create is waiting for it', async () => {
    await create('plain-feature')

    expect(lastAddOptions()).not.toHaveProperty('onCheckoutProgress')
  })

  it('keeps the phase events without a checkout field', async () => {
    await create('phase-feature', 'creation-8')

    expect(mainWindow.webContents.send).toHaveBeenCalledWith('createWorktree:progress', {
      creationId: 'creation-8',
      phase: 'creating'
    })
  })

  // Why pin this: claiming a prepared checkout never runs `git worktree add`, so the card keeps
  // today's label with no bar; the meter belongs to the add's checkout only.
  it('sends no checkout meter when the create claims a prepared checkout', async () => {
    vi.mocked(consumePreparedWorktreeCreate).mockResolvedValueOnce({
      status: 'hit',
      retargeted: false,
      result: {},
      rearm: () => {}
    })
    addWorktreeMock.mockClear()
    vi.mocked(mainWindow.webContents.send).mockClear()

    await create('prepared-feature', 'creation-9')

    expect(consumePreparedWorktreeCreate).toHaveBeenCalled()
    expect(addWorktreeMock).not.toHaveBeenCalled()
    const progressEvents = vi
      .mocked(mainWindow.webContents.send)
      .mock.calls.filter(([channel]) => channel === 'createWorktree:progress')
    expect(progressEvents).toContainEqual([
      'createWorktree:progress',
      { creationId: 'creation-9', phase: 'creating' }
    ])
    expect(progressEvents.every(([, event]) => !Object.hasOwn(Object(event), 'checkout'))).toBe(
      true
    )
  })
})
