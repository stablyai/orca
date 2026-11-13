import '../../../../shared/worktree/naming/retired-name-registry'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitWorktreeExecOptions } from '../../../git/worktrees/worktree-operation-options'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import { listWorktreesSharedStrict } from '../../../git/worktrees/catalog/worktree-scan-cache'
import '../../../git/command-runner/admission/git-subprocess-admission'
import '../../../../shared/constants'
import '../../../../shared/git/admission/git-admission-scheduler'

const {
  runtimeCreateMocks: mocks,
  worktreePath,
  writtenMeta,
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
import type { PreparationRearmHolder } from '../../../workspaces/creation/preparation/worktree-create-preparation'

import '../../../workspaces/creation/worktree-create-timing'
import { withoutInFlightWorktreeCreates } from '../../../workspaces/creation/worktree-create-in-flight'

import { registerWorktreeChangeInvalidator } from '../../../ipc/worktrees/listing/worktree-change-invalidators'
import { registerDetectedWorktreeScanInvalidation } from '../../../ipc/worktrees/listing/register-detected-worktree-scan-invalidation'
import { getWorktreeScanMutationRevision } from '../../../workspaces/catalog/local-worktree-scan-generation'
import type * as CreatedWorktreeReconciliation from '../../../ipc/created-worktree-reconciliation'

let resolveCreatedWorktree: typeof CreatedWorktreeReconciliation.resolveCreatedWorktree
beforeAll(async () => {
  registerDetectedWorktreeScanInvalidation()
  const actual = await vi.importActual<typeof CreatedWorktreeReconciliation>(
    '../../../ipc/created-worktree-reconciliation'
  )
  resolveCreatedWorktree = actual.resolveCreatedWorktree
})
beforeEach(resetRuntimeCreateMocks)

describe('runtime create listing hold', () => {
  const rows = [{ path: worktreePath }]

  it('holds the checkout during Git creation and releases it once metadata is saved', async () => {
    const revision = getWorktreeScanMutationRevision()
    const metadataAtInvalidation: number[] = []
    const unregister = registerWorktreeChangeInvalidator(() => {
      metadataAtInvalidation.push(writtenMeta.length)
    })
    mocks.consume.mockImplementation(async () => {
      expect(withoutInFlightWorktreeCreates('repo-1', rows)).toEqual([])
      return { status: 'hit', result: {}, rearm: mocks.rearm }
    })
    mocks.resolveShared.mockImplementation(async () => {
      expect(writtenMeta).toHaveLength(1)
      expect(getWorktreeScanMutationRevision()).toBe(revision + 2)
      expect(withoutInFlightWorktreeCreates('repo-1', rows)).toBe(rows)
      return []
    })
    try {
      await createWorktree()
    } finally {
      unregister()
    }
    expect(metadataAtInvalidation).toEqual([0, 1])
    expect(mocks.resolveShared).toHaveBeenCalledOnce()
    expect(getWorktreeScanMutationRevision()).toBe(revision + 2)
  })

  it('retires the post-add generation and pending Git read when actual verification fails', async () => {
    mocks.consume.mockResolvedValue({ status: 'miss', reason: 'disabled', rearm: mocks.rearm })
    let finishOldRead: (result: { stdout: string; stderr: string }) => void = () => {}
    const oldRead = new Promise<{ stdout: string; stderr: string }>((resolve) => {
      finishOldRead = resolve
    })
    let oldReadStarted = false
    // Separate deadlines keep this concurrent read distinct from the create's own verification.
    const scanOptions: GitWorktreeExecOptions = { timeout: 1_234, admissionTier: 'interactive' }
    // Warm capability negotiation so verification is not serialized behind the held read.
    await listWorktreesSharedStrict('/repo', scanOptions)
    mocks.git.mockImplementation((args: string[], options: GitWorktreeExecOptions) => {
      if (args[0] === 'worktree' && options.timeout === scanOptions.timeout && !oldReadStarted) {
        oldReadStarted = true
        return oldRead
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    let oldScan: Promise<GitWorktreeInfo[]> | undefined
    let revisionAtVerification = 0
    mocks.listing.mockImplementation((...args: Parameters<typeof resolveCreatedWorktree>) => {
      revisionAtVerification = getWorktreeScanMutationRevision()
      expect(withoutInFlightWorktreeCreates('repo-1', rows)).toEqual([])
      oldScan = listWorktreesSharedStrict('/repo', scanOptions)
      return resolveCreatedWorktree(...args)
    })
    try {
      await expect(createWorktree()).rejects.toThrow(
        `Worktree created but not found in listing: ${worktreePath} (branch app)`
      )
      expect(mocks.add).toHaveBeenCalledOnce()
      expect(mocks.git).toHaveBeenCalledWith(
        ['worktree', 'list', '--porcelain', '-z'],
        expect.objectContaining({ cwd: '/repo' })
      )
      expect(writtenMeta).toEqual([])
      expect(oldReadStarted).toBe(true)
      expect(getWorktreeScanMutationRevision()).toBe(revisionAtVerification + 1)
      expect(withoutInFlightWorktreeCreates('repo-1', rows)).toBe(rows)
      if (!oldScan) {
        throw new Error('Post-add verification did not start the concurrent scan')
      }
      const freshScan = listWorktreesSharedStrict('/repo', scanOptions)
      expect(freshScan).not.toBe(oldScan)
      await expect(freshScan).resolves.toEqual([])
    } finally {
      finishOldRead({ stdout: '', stderr: '' })
      await oldScan
    }
  })

  it('releases the checkout when Git creation fails', async () => {
    mocks.consume.mockRejectedValue(new Error('checkout failed'))
    await expect(createWorktree()).rejects.toThrow('checkout failed')
    expect(withoutInFlightWorktreeCreates('repo-1', rows)).toBe(rows)
  })
})

describe('runtime prepared-worktree replenishment', () => {
  it('arms the holder even when materialization fails', async () => {
    const revision = getWorktreeScanMutationRevision()
    mocks.copyPaths.mockRejectedValue(new Error('copy failed'))
    const rearm: PreparationRearmHolder = { fire: () => {} }
    await expect(createWorktree({}, rearm)).rejects.toThrow('copy failed')
    expect(writtenMeta).toHaveLength(1)
    expect(withoutInFlightWorktreeCreates('repo-1', [{ path: worktreePath }])).toEqual([
      { path: worktreePath }
    ])
    expect(getWorktreeScanMutationRevision()).toBe(revision + 2)
    // The slot was consumed before the failure, so the caller's `finally` must find a real thunk.
    rearm.fire()
    expect(mocks.rearm).toHaveBeenCalledOnce()
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
