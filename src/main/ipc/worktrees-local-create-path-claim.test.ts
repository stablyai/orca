import { basename } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { creatureNameTier } from '../../shared/worktree/retired-name-registry'
import type * as WorktreeLogic from './worktree-logic'
import { addWorktreeMock, describeCreatedWorktreeMock } from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers } from './worktrees-test-harness'

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
vi.mock('./pty/provider/registry', async () =>
  (await import('./worktrees-test-module-mocks')).ptyRegistryModuleMock()
)
vi.mock('./pty/provider/state-cleanup', async () =>
  (await import('./worktrees-test-module-mocks')).ptyStateCleanupModuleMock()
)

describe('desktop concurrent creates on one name', () => {
  const addedNames = (): string[] =>
    addWorktreeMock.mock.calls.map((call) => basename(String(call[1])))

  beforeEach(() => {
    setupWorktreeHandlers()
    describeCreatedWorktreeMock.mockImplementation(async (_repo, path, branch) => ({
      path,
      head: 'abc123',
      branch: `refs/heads/${branch}`,
      isBare: false,
      isMainWorktree: false
    }))
    let reached = 0
    let bothAdding: () => void = () => {}
    const gate = new Promise<void>((resolveGate) => (bothAdding = resolveGate))
    // Hold both creates inside Git's add, where neither checkout exists on disk yet.
    addWorktreeMock.mockImplementation(async () => {
      if (++reached === 2) {
        bothAdding()
      }
      await gate
      return {}
    })
  })

  it.each([
    { request: { name: 'improve-dashboard' }, second: 'improve-dashboard-2' },
    { request: { name: 'nautilus', nameWasGenerated: true }, second: null }
  ])('gives the second create of $request.name its next candidate', async ({ request, second }) => {
    const create = () => handlers['worktrees:create'](null, { repoId: 'repo-1', ...request })
    await Promise.all([create(), create()])
    const [first, other] = addedNames()
    expect(first).toBe(request.name)
    expect(other).not.toBe(first)
    if (second) {
      expect(other).toBe(second)
    } else {
      expect(creatureNameTier(other)).toBe(2)
    }
    // Both claims settled with their creates, so the name is free to check again.
    addWorktreeMock.mockResolvedValue({})
    await create()
    expect(addedNames()[2]).toBe(request.name)
  })
})
