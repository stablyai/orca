import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import type { Store } from '../persistence'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { Repo } from '../../shared/repo-types'
import { getDefaultRepoHookSettings } from '../../shared/constants'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type { AddWorktreeOptions } from '../git/worktree'
import {
  acquireGitAdmission,
  GitAdmissionScheduler,
  _resetGitAdmissionForTests
} from '../git/command-runner/git-subprocess-admission'
import { resolveGitAdmissionTier } from '../git/command-runner/git-operation-executor'

const mocks = vi.hoisted(() => ({
  rearm: vi.fn(),
  routing: vi.fn<() => { wslDistro?: string }>(),
  defaultBase: vi.fn(),
  hasBase: vi.fn(),
  branchName: vi.fn(),
  canCheckout: vi.fn(),
  branchConflict: vi.fn(),
  githubPr: vi.fn(),
  consume: vi.fn(),
  add: vi.fn(),
  addSparse: vi.fn(),
  pushTarget: vi.fn(),
  listing: vi.fn(),
  remoteBase: vi.fn(),
  hasRemoteRef: vi.fn(),
  refresh: vi.fn(),
  fetch: vi.fn(),
  resolveShared: vi.fn<() => Promise<string[]>>(),
  resolveInclude: vi.fn<() => Promise<string[]>>(),
  copyPaths: vi.fn<() => Promise<string[]>>(),
  effectiveHooks: vi.fn(),
  created: {
    path: '',
    head: 'abc123',
    branch: 'app',
    isBare: false,
    isMainWorktree: false
  }
}))

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
vi.mock('./runtime-worktree-filesystem', () => ({ runtimePathExists: async () => false }))
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

import { createRuntimeLocalManagedWorktree } from './runtime-local-worktree-create'
import type { PreparationRearmHolder } from '../worktree-create-preparation'
import {
  createWorktreeCreateTimingRecorder,
  type WorktreeCreateTimingRecorder
} from '../worktree-create-timing'
import type { SparsePreset } from '../../shared/worktree/create-types'

const worktreePath = resolve('/worktrees', 'app')

const writtenMeta: Partial<WorktreeMeta>[] = []
const WEB_PRESET: SparsePreset = {
  id: 'preset-web',
  repoId: 'repo-1',
  name: 'web',
  directories: ['apps/web', 'packages/ui'],
  createdAt: 0,
  updatedAt: 0
}
const readSparsePresets = vi.fn<(repoId: string) => SparsePreset[]>()

function createWorktree(
  request: Partial<RuntimeManagedWorktreeCreateArgs> = {},
  rearm: PreparationRearmHolder = { fire: () => {} },
  timing: WorktreeCreateTimingRecorder = createWorktreeCreateTimingRecorder(),
  repoOverrides: Partial<Repo> = {}
) {
  const store = {
    getSettings: () => ({
      workspaceDir: '/worktrees',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: ''
    }),
    setWorktreeMeta: (_id: string, updates: Partial<WorktreeMeta>) => {
      writtenMeta.push(updates)
      return updates
    },
    getSparsePresets: (repoId: string): SparsePreset[] => readSparsePresets(repoId)
  }
  return createRuntimeLocalManagedWorktree({
    request: { repoSelector: 'repo-1', name: 'app', baseBranch: 'main', ...request },
    repo: {
      id: 'repo-1',
      path: '/repo',
      displayName: 'Repo',
      badgeColor: '#000000',
      addedAt: 0,
      ...repoOverrides
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: All store methods reached by this isolated create path are supplied above.
    store: store as Store,
    createdWithAgent: undefined,
    resolveRemoteTrackingBase: mocks.remoteBase,
    hasRemoteTrackingRef: mocks.hasRemoteRef,
    refreshRemoteTrackingBase: mocks.refresh,
    fetchRemote: mocks.fetch,
    onWorktreeMetadataPersisted: () => undefined,
    rearm,
    timing
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.created.path = worktreePath
  mocks.routing.mockReturnValue({})
  mocks.defaultBase.mockImplementation(async () => {
    expect(resolveGitAdmissionTier()).toBe('interactive')
    return 'main'
  })
  mocks.hasBase.mockResolvedValue(true)
  mocks.branchName.mockResolvedValue('app')
  mocks.canCheckout.mockResolvedValue(false)
  mocks.branchConflict.mockResolvedValue(null)
  mocks.githubPr.mockResolvedValue(null)
  mocks.consume.mockResolvedValue({ status: 'hit', result: {}, rearm: mocks.rearm })
  mocks.add.mockResolvedValue({})
  mocks.addSparse.mockResolvedValue({})
  mocks.listing.mockImplementation(async () => {
    expect(resolveGitAdmissionTier()).toBe('interactive')
    return { created: mocks.created }
  })
  mocks.remoteBase.mockImplementation(async () => {
    expect(resolveGitAdmissionTier()).toBe('interactive')
    return null
  })
  mocks.hasRemoteRef.mockResolvedValue(true)
  mocks.refresh.mockResolvedValue({ ok: true })
  mocks.fetch.mockResolvedValue(undefined)
  mocks.resolveShared.mockResolvedValue([])
  mocks.resolveInclude.mockResolvedValue(['.env'])
  mocks.copyPaths.mockResolvedValue([])
  mocks.effectiveHooks.mockReturnValue(null)
  readSparsePresets.mockReturnValue([WEB_PRESET])
})

describe('runtime prepared-worktree replenishment', () => {
  it('keeps a failed claim reserved through the normal-add fallback', async () => {
    mocks.consume.mockResolvedValue({
      status: 'miss',
      reason: 'finalize_failed',
      rearm: mocks.rearm
    })
    const rearm: PreparationRearmHolder = { fire: () => {} }
    await createWorktree({}, rearm)

    expect(mocks.add).toHaveBeenCalledOnce()
    expect(mocks.rearm).not.toHaveBeenCalled()
    rearm.fire()
    expect(mocks.rearm).toHaveBeenCalledOnce()
  })

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

describe('runtime create timing', () => {
  it('times the add with the prepared-checkout consume inside it, and lists the worktrees', async () => {
    mocks.listing.mockResolvedValue({
      created: mocks.created,
      worktrees: [mocks.created, mocks.created, mocks.created],
      listingComplete: true
    })
    const timing = createWorktreeCreateTimingRecorder()

    await createWorktree({}, undefined, timing)

    expect(mocks.consume).toHaveBeenCalledWith(expect.objectContaining({ timing }))
    const finished = timing.finish()
    expect(finished.phases.map((phase) => phase.phase)).toEqual(
      expect.arrayContaining([
        'resolve_name',
        'git_worktree_add',
        'list_created_worktree',
        'persist_metadata',
        'copy_worktreeinclude'
      ])
    )
    expect(finished).toMatchObject({ executionHost: 'local', worktreeCount: 3 })
  })

  it('records a sparse create as a miss without consulting the prepared checkout', async () => {
    const timing = createWorktreeCreateTimingRecorder()

    await createWorktree({ sparseCheckout: { directories: ['src'] } }, undefined, timing)

    expect(mocks.consume).not.toHaveBeenCalled()
    expect(timing.finish().preparedCheckout).toEqual({ status: 'miss', reason: 'sparse_checkout' })
  })
})

describe('runtime create Git priority', () => {
  it.each([undefined, 'Ubuntu'])(
    'preserves interactive priority and routing on %s',
    async (wslDistro) => {
      const routing = wslDistro ? { wslDistro } : {}
      mocks.routing.mockReturnValue(routing)
      const options = routing
      const target = { remoteName: 'origin', branchName: 'app' }
      await createWorktree({ baseBranch: undefined, branchNameOverride: 'app', pushTarget: target })

      expect(mocks.defaultBase).toHaveBeenCalledWith({ cwd: '/repo', ...options })
      expect(mocks.branchName).toHaveBeenCalledWith(
        '/repo',
        'app',
        'app',
        expect.anything(),
        '',
        options
      )
      expect(mocks.canCheckout).toHaveBeenCalledWith('/repo', 'app', 'main', options)
      expect(mocks.branchConflict).toHaveBeenCalledWith('/repo', 'app', 'main', options, undefined)
      expect(mocks.githubPr).toHaveBeenCalledWith('/repo', 'app', routing)
      expect(mocks.remoteBase).toHaveBeenCalledWith('/repo', 'main', options)
      expect(mocks.hasBase).toHaveBeenCalledWith('/repo', 'main', options)
      expect(mocks.consume).toHaveBeenCalledWith(expect.objectContaining({ options }))
      expect(mocks.pushTarget).toHaveBeenCalledWith(worktreePath, 'app', target, options)
      expect(mocks.listing).toHaveBeenCalledWith('/repo', worktreePath, 'app', options)
      expect(mocks.resolveShared).toHaveBeenCalledWith('/repo', options)
      expect(mocks.resolveInclude).toHaveBeenCalledWith('/repo', options)
    }
  )

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

  it.each([
    ['exactly its directories', ['packages/ui', 'apps/web'], 'preset-web'],
    ['an edited selection', ['apps/web'], undefined]
  ])('records the sparse preset only for %s', async (_case, directories, recorded) => {
    writtenMeta.length = 0
    await createWorktree({ sparseCheckout: { directories, presetId: 'preset-web' } })

    expect(writtenMeta.find((meta) => meta.sparseDirectories)?.sparsePresetId).toBe(recorded)
  })

  it('still creates the worktree, with no sparse preset, when presets cannot be read', async () => {
    writtenMeta.length = 0
    readSparsePresets.mockImplementation(() => {
      throw new Error('corrupt presets')
    })
    await createWorktree({
      sparseCheckout: { directories: ['apps/web', 'packages/ui'], presetId: 'preset-web' }
    })

    const sparseMeta = writtenMeta.find((meta) => meta.sparseDirectories)
    expect(sparseMeta?.sparseDirectories).toEqual(['apps/web', 'packages/ui'])
    expect(sparseMeta?.sparsePresetId).toBeUndefined()
  })

  it('preserves priority for sparse creates and remote base refreshes', async () => {
    const base = {
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    }
    mocks.remoteBase.mockResolvedValue(base)
    await createWorktree({ baseBranch: 'origin/main', sparseCheckout: { directories: ['src'] } })
    const options = {}
    expect(mocks.hasRemoteRef).toHaveBeenCalledWith('/repo', base, options)
    expect(mocks.refresh).toHaveBeenCalledWith('/repo', base, options)
    expect(mocks.addSparse).toHaveBeenCalledWith(
      '/repo',
      worktreePath,
      'app',
      ['src'],
      'origin/main',
      false,
      expect.objectContaining(options)
    )
    expect(mocks.consume).not.toHaveBeenCalled()
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

  it('fetches the remote base first and creates from it when the fetch works', async () => {
    mocks.refresh.mockImplementation(async () => {
      mocks.hasRemoteRef.mockResolvedValue(true)
      return { ok: true }
    })

    const result = await createWorktree({ baseBranch: 'origin/main' })

    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(mocks.consume).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: 'origin/main',
        options: expect.objectContaining({ remoteTrackingBase: originMain })
      })
    )
    expect(result).not.toHaveProperty('baseFallback')
    expect(result.worktree.baseRef).toBe('refs/remotes/origin/main')
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

  it('keeps the not-found error when the fetch works but the tracking ref is still missing', async () => {
    mocks.hasBase.mockResolvedValue(false)
    mocks.refresh.mockResolvedValue({ ok: true })

    await expect(createWorktree({ baseBranch: 'origin/main' })).rejects.toThrow(
      'Base ref "origin/main" was not found after fetching.'
    )
    expect(mocks.consume).not.toHaveBeenCalled()
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

  it("keeps the network error when the fetch fails and there's no local branch", async () => {
    mocks.hasBase.mockResolvedValue(false)
    mocks.refresh.mockResolvedValue({ ok: false, errorKind: 'git_error' })

    await expect(
      createWorktree({ baseBranch: 'origin/main', allowLocalBaseFallback: true })
    ).rejects.toThrow(
      'Could not refresh base ref "origin/main" from "origin". Check your network and try again.'
    )
    expect(mocks.branchName).not.toHaveBeenCalled()
    expect(mocks.consume).not.toHaveBeenCalled()
  })

  it('keeps the network error for a create that did not opt into the fallback', async () => {
    mocks.refresh.mockResolvedValue({ ok: false, errorKind: 'git_error' })

    await expect(createWorktree({ baseBranch: 'origin/main' })).rejects.toThrow(
      'Could not refresh base ref "origin/main" from "origin". Check your network and try again.'
    )
    expect(mocks.consume).not.toHaveBeenCalled()
  })

  it('uses a local ref of the requested name without fetching or reporting a fallback', async () => {
    mocks.hasBase.mockResolvedValue(true)

    const result = await createWorktree({ baseBranch: 'origin/main' })

    expect(mocks.refresh).not.toHaveBeenCalled()
    expect(mocks.consume).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: 'origin/main' })
    )
    expect(result).not.toHaveProperty('baseFallback')
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
    await expect(createWorktree(request, undefined, timing, askRepo)).rejects.toThrow(
      'Setup decision required for this repository'
    )
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

  it.each([
    ['an explicit decision', { setupDecision: 'skip' as const }],
    ['runHooks', { runHooks: true }]
  ])('creates an ask repo once the request carries %s', async (_label, request) => {
    await createWorktree(request, undefined, undefined, askRepo)
    expect(mocks.consume).toHaveBeenCalledOnce()
  })
})

describe('runtime create candidate bookkeeping', () => {
  it('tells the launch the chosen path, branch and instance before adding the worktree', async () => {
    const order: string[] = []
    mocks.consume.mockImplementation(async () => {
      order.push('add')
      return { status: 'hit', result: {}, rearm: mocks.rearm }
    })
    let instanceId: string | undefined
    const onCreateCandidate = vi.fn(
      async (candidate: { worktreePath: string; branchName: string; instanceId: string }) => {
        order.push(`candidate:${candidate.branchName}`)
        expect(candidate.worktreePath).toBe(worktreePath)
        instanceId = candidate.instanceId
      }
    )

    const created = await createWorktree({ onCreateCandidate })

    expect(order).toEqual(['candidate:app', 'add'])
    // The metadata names the instance the launch recorded, so a replay can tell this worktree
    // from another later found at the same path.
    expect(instanceId).toEqual(expect.any(String))
    expect(created.worktree.instanceId).toBe(instanceId)
  })

  it('creates the worktree even when that bookkeeping fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await createWorktree({
        onCreateCandidate: async () => {
          throw new Error('disk full')
        }
      })

      expect(mocks.consume).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })
})
