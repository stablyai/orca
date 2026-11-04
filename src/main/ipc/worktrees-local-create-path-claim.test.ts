import type * as WorktreeScanCacheModule from '../git/worktrees/catalog/worktree-scan-cache'
import { basename } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { creatureNameTier } from '../../shared/worktree/retired-name-registry'
import type * as WorktreeLogic from './worktree-logic'
import { addWorktreeMock, describeCreatedWorktreeMock } from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers } from './worktrees-test-harness'

vi.mock('../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: (await import('./worktrees-test-module-mocks')).listWorktreesMock,
    listWorktreesSharedStrictAllowingTrueEmpty: (await import('./worktrees-test-module-mocks'))
      .listWorktreesMock,
    listWorktreesSharedStrict: (await import('./worktrees-test-module-mocks')).listWorktreesMock
  }
})

vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../../shared/git/worktrees/git-worktree-porcelain-parser', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  parseWorktreeList: (await import('./worktrees-test-module-mocks')).parseWorktreeListMock
}))

vi.mock('../git/worktrees/removal/worktree-removal-preflight', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertWorktreeCleanForRemoval: (await import('./worktrees-test-module-mocks'))
    .assertWorktreeCleanForRemovalMock
}))

vi.mock('../git/worktrees/creation/worktree-add', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addWorktree: (await import('./worktrees-test-module-mocks')).addWorktreeMock
}))

vi.mock('../git/worktrees/creation/worktree-sparse-add', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addSparseWorktree: (await import('./worktrees-test-module-mocks')).addSparseWorktreeMock
}))

vi.mock('../git/worktrees/removal/worktree-removal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  removeWorktree: (await import('./worktrees-test-module-mocks')).removeWorktreeMock
}))

vi.mock('../git/worktrees/removal/worktree-branch-removal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  forceDeleteLocalBranch: (await import('./worktrees-test-module-mocks')).forceDeleteLocalBranchMock
}))
vi.mock('../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorktreesStrict: (await import('./worktrees-test-module-mocks')).listWorktreesMock,
  describeCreatedWorktree: (await import('./worktrees-test-module-mocks'))
    .describeCreatedWorktreeMock
}))
const { getWorktreeRunnerMocks } = vi.hoisted(() => {
  function createWorktreeRunnerMocks() {
    return (async () => (await import('./worktrees-test-module-mocks')).gitRunnerModuleMock())()
  }
  let runner: ReturnType<typeof createWorktreeRunnerMocks> | undefined
  return { getWorktreeRunnerMocks: () => (runner ??= createWorktreeRunnerMocks()) }
})

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: (await getWorktreeRunnerMocks()).gitExecFileAsync
}))

vi.mock('../git/command-runner/git-exec-file-sync', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileSync: (await getWorktreeRunnerMocks()).gitExecFileSync
}))
vi.mock('../git/repo', async () =>
  (await import('./worktrees-test-module-mocks')).gitRepoModuleMock()
)

vi.mock('../git/repo-default-base-ref', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBaseRefDefault: (await import('./worktrees-test-module-mocks')).getBaseRefDefaultMock
}))
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

vi.mock('../git/worktrees/content-paths/worktree-symlink-detection', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  findExistingWorktreeSymlinkPaths: (await import('./worktrees-test-module-mocks'))
    .findExistingWorktreeSymlinkPathsMock
}))
vi.mock('../workspace-hooks/hooks', async () =>
  (await import('./worktrees-test-module-mocks')).hooksModuleMock()
)
vi.mock('../workspace-hooks/setup-runner-script-text', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupRunnerScriptTextModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../workspace-hooks/worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../workspace-hooks/effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../workspace-hooks/setup-hook-env-vars', async (importOriginal) =>
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
vi.mock('../pty/history/terminal-history-deletion', async () =>
  (await import('./worktrees-test-module-mocks')).terminalHistoryDeletionModuleMock()
)
vi.mock('../ports/advertised-url-watcher', async () =>
  (await import('./worktrees-test-module-mocks')).advertisedUrlWatcherModuleMock()
)
vi.mock('../workspaces/cleanup/workspace-cleanup-scan-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupScanSnapshotModuleMock()
)
vi.mock('../workspaces/space-analysis/workspace-space-analysis-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceSpaceAnalysisSnapshotModuleMock()
)
vi.mock('../workspaces/cleanup/workspace-cleanup-removal-snapshot-prune', async () =>
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
