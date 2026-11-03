import type * as WorktreeScanCacheModule from '../git/worktrees/catalog/worktree-scan-cache'
import {
  generatedNameCreateRequest,
  renameCreatedWorktreeOnFirstWork,
  typedLabelCreateRequests
} from '../workspaces/creation/worktree-create-first-work-test-harness'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { describeCreatedWorktreeMock, gitExecFileAsyncMock } from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

vi.mock('../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: (await import('./worktrees-test-module-mocks')).listWorktreesMock,
    listWorktreesSharedStrictAllowingTrueEmpty: (await import('./worktrees-test-module-mocks'))
      .listWorktreesMock,
    listWorktreesSharedStrict: (await import('./worktrees-test-module-mocks')).listWorktreesMock
  }
})

vi.mock('../text-generation/commit-message-text-generation', () => ({
  resolveTextGenerationParams: () => ({
    ok: true,
    params: { agentId: 'claude', model: 'fixture' }
  }),
  generateBranchNameFromContext: async () => ({ success: true, slug: 'fix-auth' })
}))
vi.mock('../text-generation/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: async () => ({ ok: true })
}))

vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../../shared/git-worktree-porcelain-parser', async (importOriginal) => ({
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
vi.mock('./worktree-logic', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
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

describe('desktop worktree naming through first work', () => {
  function expectCreatedWorktree(result: unknown): asserts result is CreateWorktreeResult {
    expect(result).toEqual(
      expect.objectContaining({
        worktree: expect.objectContaining({
          id: expect.any(String),
          repoId: 'repo-1',
          path: expect.any(String),
          head: expect.any(String),
          branch: expect.stringMatching(/^refs\/heads\//),
          isBare: false,
          isMainWorktree: false,
          displayName: expect.any(String),
          displayNameMode: expect.stringMatching(/^(fixed|automatic)$/),
          comment: '',
          linkedIssue: null,
          linkedPR: null,
          linkedLinearIssue: null,
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: expect.any(Number),
          lastActivityAt: expect.any(Number)
        })
      })
    )
  }

  let savedMeta: Partial<WorktreeMeta>
  beforeEach(() => {
    setupWorktreeHandlers()
    savedMeta = {}
    store.getSettings.mockReturnValue({
      branchPrefix: 'none',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      workspaceDir: '/workspace',
      autoRenameBranchFromWork: true
    })
    store.setWorktreeMeta.mockImplementation((_target, updates) => {
      savedMeta = { ...savedMeta, ...updates }
      return savedMeta
    })
    describeCreatedWorktreeMock.mockImplementation(async (_repoPath, path, branch) => ({
      path,
      branch: `refs/heads/${branch}`,
      head: 'abc123',
      isBare: false,
      isMainWorktree: false
    }))
  })

  it.each(typedLabelCreateRequests)(
    'keeps typed label $name as its branch through first work',
    async (request) => {
      const result = await handlers['worktrees:create'](null, { repoId: 'repo-1', ...request })
      expectCreatedWorktree(result)
      const expected = {
        branch: `refs/heads/${request.name}`,
        displayName: request.name,
        displayNameMode: 'fixed'
      }
      expect(result.worktree).toMatchObject(expected)
      const afterWork = await renameCreatedWorktreeOnFirstWork(
        result.worktree,
        savedMeta,
        gitExecFileAsyncMock
      )
      expect(afterWork).toMatchObject(expected)
    }
  )

  it('renames a generated creature branch on first work', async () => {
    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      ...generatedNameCreateRequest
    })
    expectCreatedWorktree(result)
    const { worktree } = result
    expect(worktree).toMatchObject({ branch: 'refs/heads/nautilus', displayNameMode: 'automatic' })
    const renamed = await renameCreatedWorktreeOnFirstWork(
      worktree,
      savedMeta,
      gitExecFileAsyncMock
    )
    expect(renamed).toMatchObject({
      branch: 'refs/heads/fix-auth',
      displayName: 'Fix auth',
      displayNameMode: 'fixed'
    })
  })

  it('uses an explicit branch name override as typed', async () => {
    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'typed-label',
      branchNameOverride: 'feature/exact'
    })
    expectCreatedWorktree(result)
    expect(result.worktree).toMatchObject({
      branch: 'refs/heads/feature/exact',
      displayName: 'typed-label',
      displayNameMode: 'fixed'
    })
  })
})
