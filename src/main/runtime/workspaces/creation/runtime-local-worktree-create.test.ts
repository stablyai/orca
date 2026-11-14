import '../../../../shared/worktree/naming/retired-name-registry'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import '../../../../shared/constants'

import '../../../git/command-runner/admission/git-subprocess-admission'
import '../../../../shared/git/admission/git-admission-scheduler'

const {
  runtimeCreateMocks: mocks,
  worktreePath,
  createWorktree,
  resetRuntimeCreateMocks
} = await vi.hoisted(async () => await import('./runtime-local-worktree-create-test-harness'))

vi.mock('../../../text-generation/commit-message-text-generation', () => ({
  resolveCommitMessageSettings: () => ({
    ok: true,
    params: { agentId: 'claude', model: 'fixture' }
  }),
  generateBranchNameFromContext: async () => ({ success: true, slug: 'fix-auth' })
}))
vi.mock('../../../text-generation/execution/commit-message-agent-environment', () => ({
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
vi.mock('../../../git/refs/resolution/repo-default-base-ref', () => ({
  getDefaultBaseRefAsync: mocks.defaultBase,
  resolveDefaultBaseRefWithLocalGit: mocks.defaultBase
}))
vi.mock('../../../git/refs/resolution/repo-branch-conflict', () => ({
  getBranchConflictKind: mocks.branchConflict
}))
vi.mock('../../../git/repositories/git-username', () => ({
  resolveLocalGitUsername: async () => ''
}))
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

import './worktree-create-setup-choice-refusal'

import '../../../workspaces/creation/worktree-create-timing'
import { withoutInFlightWorktreeCreates } from '../../../workspaces/creation/worktree-create-in-flight'

beforeEach(resetRuntimeCreateMocks)

describe('runtime create listing hold', () => {
  const rows = [{ path: worktreePath }]

  it('releases the checkout when Git creation fails', async () => {
    mocks.consume.mockRejectedValue(new Error('checkout failed'))
    await expect(createWorktree()).rejects.toThrow('checkout failed')
    expect(withoutInFlightWorktreeCreates('repo-1', rows)).toBe(rows)
  })
})

describe('runtime create base without a tracking ref', () => {
  const originMain = {
    remote: 'origin',
    branch: 'main',
    ref: 'refs/remotes/origin/main',
    base: 'origin/main'
  }

  beforeEach(() => {
    mocks.remoteBase.mockResolvedValue(originMain)
    mocks.hasRemoteRef.mockResolvedValue(false)
    // Only the local branch the remote names exists; `origin/main` itself does not resolve.
    mocks.hasBase.mockImplementation(async (_repo: string, ref: string) => ref === 'main')
  })

  it('creates from the local branch and reports it when the fetch fails', async () => {
    mocks.refresh.mockResolvedValue({ ok: false, errorKind: 'git_error' })

    const result = await createWorktree({ baseBranch: 'origin/main', allowLocalBaseFallback: true })
    expect(result.baseFallback).toEqual({ requestedRef: 'origin/main', localRef: 'main' })
    expect(result.addResult).not.toHaveProperty('baseFallback')
    expect(result.worktree.baseRef).toBe('main')
  })
})
