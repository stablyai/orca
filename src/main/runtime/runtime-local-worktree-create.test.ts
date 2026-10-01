import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import type { Store } from '../persistence'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type { AddWorktreeOptions } from '../git/worktree'
import {
  acquireGitAdmission,
  GitAdmissionScheduler,
  _resetGitAdmissionForTests
} from '../git/command-runner/git-subprocess-admission'
import { resolveGitAdmissionTier } from '../git/command-runner/git-operation-executor'

const mocks = vi.hoisted(() => ({
  routing: vi.fn<() => { wslDistro?: string }>(),
  defaultBase: vi.fn(),
  hasBase: vi.fn(),
  branchName: vi.fn(),
  canCheckout: vi.fn(),
  branchConflict: vi.fn(),
  githubPr: vi.fn(),
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
vi.mock('../git/worktree-base-ref-probe', () => ({ hasLocalWorktreeBaseRef: mocks.hasBase }))
vi.mock('./runtime-worktree-create-git', () => ({
  resolveCreateBranchName: mocks.branchName,
  canCheckoutExistingLocalBranch: mocks.canCheckout,
  getLocalGitHubPrForBranch: mocks.githubPr,
  getSelectedHostedReviewForBranch: vi.fn()
}))
vi.mock('./runtime-worktree-filesystem', () => ({ runtimePathExists: async () => false }))
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
import { isBackgroundWorkHeldForLocalCreates } from '../git/local-worktree-create-activity'
import { setActiveSink } from '../observability/tracer'

const worktreePath = resolve('/worktrees', 'app')

function createWorktree(request: Partial<RuntimeManagedWorktreeCreateArgs> = {}) {
  const store = {
    getSettings: () => ({
      workspaceDir: '/worktrees',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: ''
    }),
    setWorktreeMeta: (_id: string, updates: Partial<WorktreeMeta>) => updates
  }
  return createRuntimeLocalManagedWorktree({
    request: { repoSelector: 'repo-1', name: 'app', baseBranch: 'main', ...request },
    repo: { id: 'repo-1', path: '/repo', displayName: 'Repo', badgeColor: '#000000', addedAt: 0 },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: All store methods reached by this isolated create path are supplied above.
    store: store as Store,
    createdWithAgent: undefined,
    resolveRemoteTrackingBase: mocks.remoteBase,
    hasRemoteTrackingRef: mocks.hasRemoteRef,
    refreshRemoteTrackingBase: mocks.refresh,
    fetchRemote: mocks.fetch,
    onWorktreeMetadataPersisted: () => undefined
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
})

describe('runtime create holds background work off', () => {
  it('is in flight from the start of the create until it settles', async () => {
    let finishAdd!: () => void
    mocks.add.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishAdd = () => resolve({})
        })
    )
    expect(isBackgroundWorkHeldForLocalCreates()).toBe(false)
    const creation = createWorktree()
    await vi.waitFor(() => expect(mocks.add).toHaveBeenCalledOnce())
    expect(isBackgroundWorkHeldForLocalCreates()).toBe(true)
    finishAdd()
    await creation
    expect(isBackgroundWorkHeldForLocalCreates()).toBe(false)
  })

  it('releases the hold when the create fails', async () => {
    mocks.add.mockRejectedValue(new Error('add failed'))
    await expect(createWorktree()).rejects.toThrow('add failed')
    expect(isBackgroundWorkHeldForLocalCreates()).toBe(false)
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
      expect(mocks.add).toHaveBeenCalledWith(
        '/repo',
        worktreePath,
        'app',
        'main',
        false,
        false,
        expect.objectContaining(options)
      )
      expect(mocks.pushTarget).toHaveBeenCalledWith(worktreePath, 'app', target, options)
      expect(mocks.listing).toHaveBeenCalledWith('/repo', worktreePath, 'app', options)
      expect(mocks.resolveShared).toHaveBeenCalledWith('/repo', options)
      expect(mocks.resolveInclude).toHaveBeenCalledWith('/repo', options)
    }
  )

  it('creates through interactive headroom when regular Git capacity is occupied', async () => {
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
  })
})

describe('runtime create span', () => {
  function captureSpans(): unknown[] {
    const records: unknown[] = []
    setActiveSink({ push: (record) => records.push(record), flush: () => {}, close: () => {} })
    return records
  }

  it('records whether the create used a spare, as the IPC create does', async () => {
    const records = captureSpans()
    mocks.add.mockResolvedValue({ preparedCheckout: { status: 'miss', reason: 'not_ready' } })
    try {
      await createWorktree()
    } finally {
      setActiveSink(null)
    }

    expect(records).toMatchObject([
      {
        name: 'worktree.create',
        attributes: {
          'worktree.create.prepared_checkout': 'miss',
          'worktree.create.prepared_checkout_miss': 'not_ready'
        }
      }
    ])
  })

  it('records a sparse create as a sparse_checkout miss', async () => {
    const records = captureSpans()
    try {
      await createWorktree({ sparseCheckout: { directories: ['src'] } })
    } finally {
      setActiveSink(null)
    }

    expect(records).toMatchObject([
      { attributes: { 'worktree.create.prepared_checkout_miss': 'sparse_checkout' } }
    ])
  })
})
