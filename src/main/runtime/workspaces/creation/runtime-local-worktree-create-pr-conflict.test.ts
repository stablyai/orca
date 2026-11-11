import { beforeEach, describe, expect, it, vi } from 'vitest'
import 'node:path'

const {
  runtimeCreateMocks: mocks,
  createWorktree,
  resetRuntimeCreateMocks
} = await vi.hoisted(async () => await import('./runtime-local-worktree-create-test-harness'))

vi.mock('../../../text-generation/commit-message-text-generation', () => ({
  resolveTextGenerationParams: () => ({
    ok: true,
    params: { agentId: 'claude', model: 'fixture' }
  }),
  generateBranchNameFromContext: async () => ({ success: true, slug: 'fix-auth' })
}))
vi.mock('../../../text-generation/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: async () => ({ ok: true })
}))

vi.mock('../../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: mocks.git
}))
vi.mock('../../../workspaces/execution-host/project-runtime-git-options', () => ({
  getLocalProjectGitExecOptions: () => ({ cwd: '/repo', ...mocks.routing() }),
  getLocalProjectWorktreeGitOptions: mocks.routing,
  getWorktreeMirrorDistro: () => undefined
}))
vi.mock('../../../git/repo-default-base-ref', () => ({
  getBaseRefDefault: mocks.defaultBase,
  resolveDefaultBaseRefWithLocalGit: mocks.defaultBase
}))
vi.mock('../../../git/repo-branch-conflict', () => ({
  getBranchConflictKind: mocks.branchConflict
}))
vi.mock('../../../git/git-username', () => ({ resolveLocalGitUsername: async () => '' }))
vi.mock('../../../workspace-hooks/hooks', () => ({ getEffectiveHooks: mocks.effectiveHooks }))
vi.mock('../../../git/worktrees/creation/worktree-base-ref-probe', () => ({
  hasLocalWorktreeBaseRef: mocks.hasBase
}))
vi.mock('./runtime-worktree-create-git', () => ({
  resolveCreateBranchName: mocks.branchName,
  canCheckoutExistingLocalBranch: mocks.canCheckout,
  getLocalGitHubPrForBranch: mocks.githubPr,
  getSelectedHostedReviewForBranch: vi.fn()
}))
vi.mock('../catalog/runtime-worktree-filesystem', () => ({ runtimePathExists: mocks.pathExists }))
vi.mock('../../../workspaces/creation/preparation/worktree-create-preparation', () => ({
  consumePreparedWorktreeCreate: mocks.consume
}))
vi.mock('../../../git/worktrees/creation/worktree-add', () => ({
  addWorktree: mocks.add
}))

vi.mock('../../../git/worktrees/creation/worktree-sparse-add', () => ({
  addSparseWorktree: mocks.addSparse
}))
vi.mock('../../../ipc/worktree-remote', () => ({
  configureCreatedWorktreePushTarget: mocks.pushTarget
}))
vi.mock('../../../ipc/created-worktree-reconciliation', () => ({
  resolveCreatedWorktree: mocks.listing
}))
vi.mock('../../../workspaces/removal/retirement/worktree-name-retirement', () => ({
  failedWorktreeCreationNeedsRetirement: vi.fn(),
  retireGeneratedWorktreeName: vi.fn()
}))
vi.mock('../../../git/worktrees/content-paths/worktree-shared-directories', () => ({
  resolveWorktreeSharedDirectories: mocks.resolveShared
}))
vi.mock('../../../git/worktrees/content-paths/worktree-include-file', () => ({
  resolveWorktreeIncludePaths: mocks.resolveInclude
}))
vi.mock('../../../ipc/worktree-symlinks', () => ({
  createWorktreeCopiedPaths: mocks.copyPaths,
  createWorktreeLinkedPaths: vi.fn(),
  createWorktreeSharedPaths: vi.fn()
}))

beforeEach(resetRuntimeCreateMocks)

describe('runtime create PR conflict probe', () => {
  const remoteTrackingBase = {
    remote: 'origin',
    branch: 'main',
    base: 'origin/main',
    ref: 'refs/remotes/origin/main'
  }

  beforeEach(() => {
    mocks.branchName.mockImplementation(async (_path, override, name: string) => override ?? name)
  })

  it('reports the naming failure when the started base fetch also fails', async () => {
    mocks.remoteBase.mockResolvedValue(remoteTrackingBase)
    mocks.refresh.mockRejectedValue(new Error('offline'))
    mocks.branchConflict.mockResolvedValue('local')
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      await expect(createWorktree()).rejects.toThrow('Branch "app-')
      await new Promise((resolve) => setImmediate(resolve))
      expect(mocks.refresh).toHaveBeenCalledOnce()
      expect(unhandled).not.toHaveBeenCalled()
      expect(mocks.consume).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('reports the naming failure when the started origin fetch also fails', async () => {
    mocks.hasBase.mockResolvedValue(false)
    mocks.fetch.mockRejectedValue(new Error('offline'))
    mocks.branchConflict.mockResolvedValue('local')
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      await expect(createWorktree()).rejects.toThrow('Branch "app-')
      await new Promise((resolve) => setImmediate(resolve))
      expect(mocks.fetch).toHaveBeenCalledOnce()
      expect(unhandled).not.toHaveBeenCalled()
      expect(mocks.consume).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})
