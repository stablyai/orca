import { creatureNameTier } from '../../shared/worktree/retired-name-registry'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { basename } from 'node:path'
import type { Repo } from '../../shared/repo-types'
import { getDefaultRepoHookSettings } from '../../shared/constants'
import type { AddWorktreeOptions } from '../git/worktree'
import {
  acquireGitAdmission,
  GitAdmissionScheduler,
  _resetGitAdmissionForTests
} from '../git/command-runner/git-subprocess-admission'

const {
  runtimeCreateMocks: mocks,
  worktreePath,
  createWorktree,
  resetRuntimeCreateMocks
} = await vi.hoisted(async () => await import('./runtime-local-worktree-create-test-harness'))

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

vi.mock('../git/runner', () => ({ gitExecFileAsync: mocks.git }))
vi.mock('../project-runtime-git-options', () => ({
  getLocalProjectGitExecOptions: () => ({ cwd: '/repo', ...mocks.routing() }),
  getLocalProjectWorktreeGitOptions: mocks.routing,
  getWorktreeMirrorDistro: () => undefined
}))
vi.mock('../git/repo', () => ({
  getBaseRefDefault: mocks.defaultBase,
  resolveDefaultBaseRefWithLocalGit: mocks.defaultBase,
  getBranchConflictKind: mocks.branchConflict
}))
vi.mock('../git/git-username', () => ({ resolveLocalGitUsername: async () => '' }))
vi.mock('../hooks', () => ({ getEffectiveHooks: mocks.effectiveHooks }))
vi.mock('../git/worktree-base-ref-probe', () => ({ hasLocalWorktreeBaseRef: mocks.hasBase }))
vi.mock('./runtime-worktree-create-git', () => ({
  resolveCreateBranchName: mocks.branchName,
  canCheckoutExistingLocalBranch: mocks.canCheckout,
  getLocalGitHubPrForBranch: mocks.githubPr,
  getSelectedHostedReviewForBranch: vi.fn()
}))
vi.mock('./runtime-worktree-filesystem', () => ({ runtimePathExists: mocks.pathExists }))
vi.mock('../worktree-create-preparation', () => ({ consumePreparedWorktreeCreate: mocks.consume }))
vi.mock('../git/worktree', () => ({ addWorktree: mocks.add, addSparseWorktree: mocks.addSparse }))
vi.mock('../ipc/worktree-remote', () => ({ configureCreatedWorktreePushTarget: mocks.pushTarget }))
vi.mock('../ipc/created-worktree-reconciliation', () => ({ resolveCreatedWorktree: mocks.listing }))
vi.mock('../worktree-name-retirement', () => ({
  failedWorktreeCreationNeedsRetirement: vi.fn(),
  retireGeneratedWorktreeName: vi.fn()
}))
vi.mock('../git/worktree-shared-directories', () => ({
  resolveWorktreeSharedDirectories: mocks.resolveShared
}))
vi.mock('../git/worktree-include-file', () => ({
  resolveWorktreeIncludePaths: mocks.resolveInclude
}))
vi.mock('../ipc/worktree-symlinks', () => ({
  createWorktreeCopiedPaths: mocks.copyPaths,
  createWorktreeLinkedPaths: vi.fn(),
  createWorktreeSharedPaths: vi.fn()
}))

import { WorktreeCreateSetupChoiceRefusedError } from './worktree-create-setup-choice-refusal'
import type { PreparationRearmHolder } from '../worktree-create-preparation'
import { createWorktreeCreateTimingRecorder } from '../worktree-create-timing'
import { withoutInFlightWorktreeCreates } from '../worktree-create-in-flight'

beforeEach(resetRuntimeCreateMocks)

describe('runtime create listing hold', () => {
  const rows = [{ path: worktreePath }]

  it('holds the checkout during Git creation and releases it once metadata is saved', async () => {
    mocks.consume.mockImplementation(async () => {
      expect(withoutInFlightWorktreeCreates('repo-1', rows)).toEqual([])
      return { status: 'hit', result: {}, rearm: mocks.rearm }
    })
    mocks.resolveShared.mockImplementation(async () => {
      expect(withoutInFlightWorktreeCreates('repo-1', rows)).toBe(rows)
      return []
    })
    await createWorktree()
    expect(mocks.resolveShared).toHaveBeenCalledOnce()
  })

  it('releases the checkout when Git creation fails', async () => {
    mocks.consume.mockRejectedValue(new Error('checkout failed'))
    await expect(createWorktree()).rejects.toThrow('checkout failed')
    expect(withoutInFlightWorktreeCreates('repo-1', rows)).toBe(rows)
  })
})

describe('runtime concurrent creates on one name', () => {
  const addedPaths = (): string[] => mocks.add.mock.calls.map((call) => String(call[1]))

  beforeEach(() => {
    mocks.consume.mockResolvedValue({ status: 'miss', reason: 'disabled', rearm: mocks.rearm })
    let reached = 0
    let bothAdding: () => void = () => {}
    const gate = new Promise<void>((resolveGate) => (bothAdding = resolveGate))
    // Hold both creates inside Git's add, where neither checkout exists on disk yet.
    mocks.add.mockImplementation(async () => {
      if (++reached === 2) {
        bothAdding()
      }
      await gate
      return {}
    })
  })

  it.each([
    { request: { name: 'app' }, second: 'app-2' },
    { request: { name: 'nautilus', nameWasGenerated: true }, second: null }
  ])('gives the second create of $request.name its next candidate', async ({ request, second }) => {
    await Promise.all([createWorktree(request), createWorktree(request)])
    // Claims are ordered, but each create resolves its path's realpath before Git's add, so on a
    // loaded runner either create can reach add first. Check the names, not the call order.
    const names = addedPaths().map((path) => basename(path))
    expect(names.filter((name) => name === request.name)).toHaveLength(1)
    const other = names.find((name) => name !== request.name) ?? ''
    if (second) {
      expect(other).toBe(second)
    } else {
      expect(creatureNameTier(other)).toBe(2)
    }
    // Both claims settled with their creates, so the name is free to check again.
    mocks.add.mockResolvedValue({})
    await createWorktree(request)
    expect(basename(addedPaths()[2])).toBe(request.name)
  })

  it('releases the claim when the create fails', async () => {
    mocks.add.mockRejectedValueOnce(new Error('add failed'))
    await expect(createWorktree({ name: 'app' })).rejects.toThrow('add failed')
    mocks.add.mockResolvedValue({})
    await createWorktree({ name: 'app' })
    expect(addedPaths().map((path) => basename(path))).toEqual(['app', 'app'])
  })
})

describe('runtime prepared-worktree replenishment', () => {
  it('keeps the failed claim release available when the fallback also fails', async () => {
    mocks.consume.mockResolvedValue({
      status: 'miss',
      reason: 'prepare_failed',
      rearm: mocks.rearm
    })
    mocks.add.mockRejectedValue(new Error('normal add failed'))
    const rearm: PreparationRearmHolder = { fire: () => {} }
    await expect(createWorktree({}, rearm)).rejects.toThrow('normal add failed')

    expect(mocks.rearm).not.toHaveBeenCalled()
    rearm.fire()
    expect(mocks.rearm).toHaveBeenCalledOnce()
  })

  it('leaves the re-arm holder armed but unfired once probes and include copies finish', async () => {
    const rearm: PreparationRearmHolder = { fire: () => {} }
    let finishProbe!: (paths: string[]) => void
    mocks.resolveShared.mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          finishProbe = resolve
        })
    )
    let finishCopy!: (paths: string[]) => void
    mocks.copyPaths.mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          finishCopy = resolve
        })
    )
    const creation = createWorktree({}, rearm)
    await vi.waitFor(() => expect(mocks.resolveShared).toHaveBeenCalledOnce())
    expect(mocks.rearm).not.toHaveBeenCalled()
    finishProbe([])
    await vi.waitFor(() => expect(mocks.copyPaths).toHaveBeenCalledOnce())
    expect(mocks.rearm).not.toHaveBeenCalled()
    finishCopy([])
    await creation
    // The caller launches terminals before arming, so create must not fire it itself.
    expect(mocks.rearm).not.toHaveBeenCalled()
    rearm.fire()
    expect(mocks.rearm).toHaveBeenCalledOnce()
  })

  it('arms the holder even when materialization fails', async () => {
    mocks.copyPaths.mockRejectedValue(new Error('copy failed'))
    const rearm: PreparationRearmHolder = { fire: () => {} }
    await expect(createWorktree({}, rearm)).rejects.toThrow('copy failed')
    // The slot was consumed before the failure, so the caller's `finally` must find a real thunk.
    rearm.fire()
    expect(mocks.rearm).toHaveBeenCalledOnce()
  })
})

describe('runtime create Git priority', () => {
  it('creates through interactive headroom when regular Git capacity is occupied', async () => {
    mocks.consume.mockResolvedValue({ status: 'miss', reason: 'none_armed' })
    const scheduler = new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 1 })
    _resetGitAdmissionForTests(scheduler)
    const blocker = await acquireGitAdmission({ args: ['status'], cwd: '/repo' })
    mocks.add.mockImplementation(
      async (
        _repo: string,
        _path: string,
        _branch: string,
        _base: string,
        _refresh: boolean,
        _existing: boolean,
        options?: AddWorktreeOptions
      ) => {
        const grant = await acquireGitAdmission({
          args: ['worktree', 'add'],
          cwd: '/repo',
          tier: options?.admissionTier,
          signal: AbortSignal.timeout(200)
        })
        grant.release()
        return {}
      }
    )
    try {
      await expect(createWorktree()).resolves.toHaveProperty('worktreePath', worktreePath)
      expect(mocks.add).toHaveBeenCalledOnce()
    } finally {
      blocker.release()
      _resetGitAdmissionForTests()
    }
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

  it('names the workspace only after the fetch has settled', async () => {
    let refreshSettled = false
    mocks.refresh.mockImplementation(async () => {
      await Promise.resolve()
      mocks.hasRemoteRef.mockResolvedValue(true)
      refreshSettled = true
      return { ok: true }
    })
    const settledAtNaming: boolean[] = []
    mocks.canCheckout.mockImplementation(async () => {
      settledAtNaming.push(refreshSettled)
      return false
    })

    await createWorktree({ baseBranch: 'origin/main', branchNameOverride: 'app' })

    expect(settledAtNaming).toEqual([true])
    expect(mocks.canCheckout).toHaveBeenCalledWith('/repo', 'app', 'origin/main', {})
    expect(mocks.branchConflict).toHaveBeenCalledWith('/repo', 'app', 'origin/main', {}, undefined)
  })

  it('creates from the local branch and reports it when the fetch fails', async () => {
    mocks.refresh.mockResolvedValue({ ok: false, errorKind: 'git_error' })

    const result = await createWorktree({ baseBranch: 'origin/main', allowLocalBaseFallback: true })

    expect(mocks.consume).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: 'main',
        options: expect.not.objectContaining({ remoteTrackingBase: expect.anything() })
      })
    )
    expect(result.baseFallback).toEqual({ requestedRef: 'origin/main', localRef: 'main' })
    expect(result.addResult).not.toHaveProperty('baseFallback')
    expect(result.worktree.baseRef).toBe('main')
  })

  it('decides the base before branch reuse and conflict checks', async () => {
    mocks.refresh.mockResolvedValue({ ok: false, errorKind: 'git_error' })

    await createWorktree({
      baseBranch: 'origin/main',
      branchNameOverride: 'app',
      allowLocalBaseFallback: true
    })

    expect(mocks.refresh.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.canCheckout.mock.invocationCallOrder[0]
    )
    expect(mocks.canCheckout).toHaveBeenCalledWith('/repo', 'app', 'main', {})
    expect(mocks.branchConflict).toHaveBeenCalledWith('/repo', 'app', 'main', {}, undefined)
  })
})

describe('runtime create setup decision', () => {
  const askRepo: Partial<Repo> = {
    hookSettings: { ...getDefaultRepoHookSettings(), setupRunPolicy: 'ask' }
  }

  beforeEach(() => {
    mocks.effectiveHooks.mockReturnValue({ scripts: { setup: 'pnpm install' } })
  })

  it('refuses an ask repo with no decision before any git work', async () => {
    const timing = createWorktreeCreateTimingRecorder()
    // No requested base, so a create that got past the check would resolve the default base.
    const request = { baseBranch: undefined }
    const refusal = await createWorktree(request, undefined, timing, askRepo).catch(
      (error: unknown) => error
    )
    expect(refusal).toBeInstanceOf(WorktreeCreateSetupChoiceRefusedError)
    expect(refusal).toMatchObject({ message: 'Setup decision required for this repository' })
    // Hooks come from the main checkout (no worktree path): the new worktree doesn't exist yet.
    expect(mocks.effectiveHooks.mock.calls).toEqual([[expect.objectContaining({ path: '/repo' })]])
    for (const gitWork of [mocks.defaultBase, mocks.remoteBase, mocks.hasBase, mocks.refresh]) {
      expect(gitWork).not.toHaveBeenCalled()
    }
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.branchName).not.toHaveBeenCalled()
    expect(mocks.consume).not.toHaveBeenCalled()
    expect(mocks.add).not.toHaveBeenCalled()
    // The refusal's failure telemetry still says where the create ran.
    expect(timing.finish().executionHost).toBe('local')
  })
})
