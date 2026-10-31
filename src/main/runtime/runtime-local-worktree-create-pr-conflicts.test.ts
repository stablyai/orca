import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import type { Store } from '../persistence'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import { resolveGitAdmissionTier } from '../git/command-runner/git-operation-executor'

const mocks = vi.hoisted(() => ({
  git: vi.fn(),
  rearm: vi.fn(),
  routing: vi.fn<() => { wslDistro?: string }>(),
  defaultBase: vi.fn(),
  hasBase: vi.fn(),
  branchName: vi.fn(),
  canCheckout: vi.fn(),
  pathExists: vi.fn(),
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

import { createRuntimeLocalManagedWorktree } from './runtime-local-worktree-create'
import type { PreparationRearmHolder } from '../worktree-create-preparation'
import {
  createWorktreeCreateTimingRecorder,
  type WorktreeCreateTimingRecorder
} from '../worktree-create-timing'
import type { SparsePreset } from '../../shared/worktree/create-types'

const worktreePath = resolve('/worktrees', 'app')

const pickedBranch = {
  baseBranch: 'origin/main',
  branchNameOverride: 'main',
  branchIntent: 'open-existing-v2'
} as const

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
  repoOverrides: Partial<Repo> = {},
  autoRenameBranchFromWork = false
) {
  const store = {
    getSettings: () => ({
      workspaceDir: '/worktrees',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: '',
      autoRenameBranchFromWork
    }),
    setWorktreeMeta: (_target: HostWorktreeTarget, updates: Partial<WorktreeMeta>) => {
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
    // vi.fn marks returned promises handled; a fresh promise exposes unawaited fetch rejection.
    refreshRemoteTrackingBase: async (...refreshArgs) => await mocks.refresh(...refreshArgs),
    fetchRemote: async (...fetchArgs) => await mocks.fetch(...fetchArgs),
    onWorktreeMetadataPersisted: () => undefined,
    rearm,
    timing
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  writtenMeta.length = 0
  mocks.created.branch = 'app'
  mocks.git.mockResolvedValue({ stdout: '', stderr: '' })
  mocks.created.path = worktreePath
  mocks.routing.mockReturnValue({})
  mocks.defaultBase.mockImplementation(async () => {
    expect(resolveGitAdmissionTier()).toBe('interactive')
    return 'main'
  })
  mocks.hasBase.mockResolvedValue(true)
  mocks.branchName.mockResolvedValue('app')
  mocks.canCheckout.mockResolvedValue(false)
  mocks.pathExists.mockResolvedValue(false)
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

  it.each([1, 10])(
    'keeps the selected name and source through %i occupied paths, without PR eligibility',
    async (occupied) => {
      const options = { wslDistro: 'Ubuntu' }
      mocks.routing.mockReturnValue(options)
      mocks.remoteBase.mockResolvedValue(remoteTrackingBase)
      mocks.githubPr.mockResolvedValue({ number: 42 })
      let pathChecks = 0
      mocks.pathExists.mockImplementation(async () => pathChecks++ < occupied)

      await createWorktree({ ...pickedBranch, sparseCheckout: { directories: ['src'] } })

      expect(mocks.remoteBase.mock.calls).toEqual([['/repo', 'origin/main', options]])
      expect(mocks.branchName).toHaveBeenCalledOnce()
      expect(mocks.branchConflict.mock.calls).toEqual([
        ['/repo', 'main', remoteTrackingBase.ref, options]
      ])
      expect(mocks.pathExists).toHaveBeenCalledTimes(occupied + 1)
      expect(mocks.githubPr).not.toHaveBeenCalled()
      expect(mocks.consume).not.toHaveBeenCalled()
      expect(mocks.addSparse).toHaveBeenCalledExactlyOnceWith(
        '/repo',
        resolve('/worktrees', `app-${occupied + 1}`),
        'main',
        ['src'],
        remoteTrackingBase.base,
        false,
        expect.objectContaining({ remoteTrackingBase, trackRemoteBranch: true, ...options })
      )
    }
  )

  it.each([true, false])(
    'keeps local eligibility with picker intent (reusable: %s)',
    async (reusable) => {
      mocks.branchConflict.mockImplementation(async (_path, branch: string) =>
        branch === 'main' ? 'local' : null
      )
      mocks.canCheckout.mockImplementation(
        async (_path, branch: string) => reusable && branch === 'main'
      )
      mocks.pathExists.mockImplementation(async (path) => path === worktreePath)
      mocks.consume.mockResolvedValue({ status: 'miss', reason: 'not_prepared' })

      if (!reusable) {
        await expect(createWorktree(pickedBranch)).rejects.toThrow('was not found locally')
        expect(mocks.add).not.toHaveBeenCalled()
        expect(mocks.consume).not.toHaveBeenCalled()
        return
      }
      await createWorktree(pickedBranch)
      expect(mocks.add).toHaveBeenCalledWith(
        '/repo',
        resolve('/worktrees', 'app-2'),
        'main',
        'origin/main',
        false,
        false,
        expect.objectContaining({ checkoutExistingBranch: true })
      )
      expect(mocks.githubPr).not.toHaveBeenCalled()
    }
  )

  it('keeps unflagged legacy, mobile New branch and Advanced collisions on baseline allocation', async () => {
    mocks.consume.mockResolvedValue({ status: 'miss', reason: 'not_prepared' })
    mocks.branchName.mockImplementation(async (_path, override, name: string) => override ?? name)
    mocks.branchConflict.mockImplementation(async (_path, branch: string) =>
      branch === 'feature/test' ? 'remote' : null
    )

    await createWorktree({ branchNameOverride: 'feature/test', baseBranch: 'origin/main' })

    expect(mocks.add.mock.calls[0][2]).toBe('feature/test-2')
  })

  it('runs the first name PR lookup while the base fetch is still in flight', async () => {
    mocks.remoteBase.mockResolvedValue(remoteTrackingBase)
    let finishFetch!: () => void
    mocks.refresh.mockReturnValue(
      new Promise((resolve) => {
        finishFetch = () => resolve({ ok: true })
      })
    )
    let fetchPendingAtLookup = false
    mocks.githubPr.mockImplementation(async () => {
      fetchPendingAtLookup = mocks.refresh.mock.calls.length === 1
      finishFetch?.()
      return null
    })

    await createWorktree()

    expect(fetchPendingAtLookup).toBe(true)
    expect(mocks.githubPr).toHaveBeenCalledWith('/repo', 'app', {})
    expect(mocks.consume).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'app',
        options: expect.objectContaining({ remoteTrackingBase })
      })
    )
  })

  it('suffixes past a PR on the first name', async () => {
    mocks.githubPr.mockResolvedValueOnce({ number: 7, state: 'closed' }).mockResolvedValue(null)

    await createWorktree()

    expect(mocks.githubPr.mock.calls.map(([, branch]) => branch)).toEqual(['app', 'app-2'])
    expect(mocks.consume).toHaveBeenCalledWith(expect.objectContaining({ branch: 'app-2' }))
  })

  it.each([undefined, 'Ubuntu'])(
    'probes the next name for a PR once the first name collides, routed for %s',
    async (wslDistro) => {
      const routing = wslDistro ? { wslDistro } : {}
      mocks.routing.mockReturnValue(routing)
      mocks.branchConflict.mockResolvedValueOnce('local').mockResolvedValue(null)

      await createWorktree()

      expect(mocks.githubPr).toHaveBeenCalledOnce()
      expect(mocks.githubPr).toHaveBeenCalledWith('/repo', 'app-2', routing)
    }
  )

  it('skips a later name that already has a PR', async () => {
    mocks.branchConflict.mockResolvedValueOnce('local').mockResolvedValue(null)
    mocks.githubPr.mockResolvedValueOnce({ number: 7, state: 'closed' }).mockResolvedValue(null)

    await createWorktree()

    expect(mocks.githubPr.mock.calls.map(([, branch]) => branch)).toEqual(['app-2', 'app-3'])
    expect(mocks.consume).toHaveBeenCalledWith(expect.objectContaining({ branch: 'app-3' }))
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

  it('runs the first name PR lookup while the origin fetch is still in flight', async () => {
    mocks.hasBase.mockResolvedValue(false)
    let finishFetch!: () => void
    mocks.fetch.mockReturnValue(
      new Promise<void>((resolve) => {
        finishFetch = resolve
      })
    )
    let fetchPendingAtLookup = false
    mocks.githubPr.mockImplementation(async () => {
      fetchPendingAtLookup = mocks.fetch.mock.calls.length === 1
      finishFetch?.()
      return null
    })

    await createWorktree()

    expect(fetchPendingAtLookup).toBe(true)
    expect(mocks.fetch).toHaveBeenCalledWith('/repo', 'origin', {})
    expect(mocks.consume).toHaveBeenCalledWith(expect.objectContaining({ branch: 'app' }))
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
