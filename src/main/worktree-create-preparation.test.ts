import { mocks, repo, store, flushBackgroundWork } from './__mocks__/worktree-create-preparation'
import { describe, expect, it } from 'vitest'
import type { Repo } from '../shared/repo-types'
import { hasPendingStalePreparationCleanup } from './worktree-create-preparation-stale-cleanup'
import { WORKTREE_CREATE_PREPARATION_DIRECTORY } from '../shared/worktree/create-preparation'
import { WorktreePreparationLockOwnershipError } from './git/worktree-preparation-lock'
import {
  _resetWorktreeCreatePreparationsForTests,
  consumePreparedWorktreeCreate,
  hasPendingWorktreeCreatePreparations,
  prepareWorktreeCreateForRepo
} from './worktree-create-preparation'

describe('worktree create preparation registry', () => {
  it.each([undefined, 'Ubuntu'])(
    'preserves create priority through claim probes on %s',
    async (wslDistro) => {
      const routing = wslDistro ? { wslDistro } : {}
      mocks.getWorktreeOptions.mockReturnValue(routing)
      await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
      expect(mocks.resolveBaseRef).toHaveBeenLastCalledWith(repo.path, 'origin/main', routing)
      expect(mocks.prepareCheckout.mock.calls[0]?.[4]).not.toHaveProperty('admissionTier')

      const options = { ...routing, admissionTier: 'interactive' as const }
      await expect(
        consumePreparedWorktreeCreate({
          repoPath: repo.path,
          workspaceRoot: '/workspace',
          worktreePath: '/workspace/final',
          branch: 'feature/test',
          baseBranch: 'main',
          options
        })
      ).resolves.toMatchObject({ status: 'hit', retargeted: true })
      expect(mocks.resolveBaseRef).toHaveBeenLastCalledWith(repo.path, 'main', options)
      expect(mocks.measureDivergence).toHaveBeenCalledWith(
        repo.path,
        'refs/remotes/origin/main',
        'refs/heads/main',
        options
      )
    }
  )

  it('starts the checkout only once the async workspace root resolves', async () => {
    let resolveRoot!: (root: string) => void
    mocks.computeWorkspaceRootAsync.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveRoot = resolve
      })
    )

    const preparation = prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    await Promise.resolve()
    expect(mocks.prepareCheckout).not.toHaveBeenCalled()

    resolveRoot('/workspace')
    await preparation

    expect(mocks.computeWorkspaceRoot).not.toHaveBeenCalled()
    expect(mocks.prepareCheckout).toHaveBeenCalledTimes(1)
  })

  it('still deduplicates when both callers await the same pending root lookup', async () => {
    let resolveRoot!: (root: string) => void
    mocks.computeWorkspaceRootAsync.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveRoot = resolve
      })
    )

    const first = prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const second = prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    resolveRoot('/workspace')
    await Promise.all([first, second])

    expect(mocks.prepareCheckout).toHaveBeenCalledTimes(1)
  })

  it('namespaces native Windows preparation directories for long paths', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      await prepareWorktreeCreateForRepo(store, { ...repo, path: 'C:\\repo' }, 'origin/main')

      expect(mocks.mkdir).toHaveBeenCalledWith(
        expect.stringMatching(/^\\\\\?\\C:\\workspace\\\.orca-preparing/),
        { recursive: true }
      )
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('deduplicates preparation for the same repo, base, runtime, and workspace root', async () => {
    await Promise.all([
      prepareWorktreeCreateForRepo(store, repo, 'origin/main'),
      prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    ])

    expect(mocks.prepareCheckout).toHaveBeenCalledTimes(1)
  })

  it('does not claim a preparation after the selected base changes to another branch', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')

    await expect(
      consumePreparedWorktreeCreate({
        repoPath: repo.path,
        workspaceRoot: '/workspace',
        worktreePath: '/workspace/final',
        branch: 'feature/test',
        baseBranch: 'origin/release'
      })
    ).resolves.toEqual({ status: 'miss', reason: 'base_mismatch' })
    expect(mocks.finalize).not.toHaveBeenCalled()
  })

  it('claims across the local/remote spelling of the same base and reports the retarget', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')

    // `main` has no local ref here, so the canonical forms differ and only the base family matches.
    await expect(
      consumePreparedWorktreeCreate({
        repoPath: repo.path,
        workspaceRoot: '/workspace',
        worktreePath: '/workspace/final',
        branch: 'feature/test',
        baseBranch: 'main'
      })
    ).resolves.toEqual({
      status: 'hit',
      retargeted: true,
      // The mocked finalize found the checkout already at the requested commit.
      reset: 'none',
      buildMs: expect.any(Number),
      idleMs: expect.any(Number),
      origin: 'prefetch',
      result: {},
      rearm: expect.any(Function)
    })
    // Finalize still receives the requested base, so it resets onto the requested commit.
    expect(mocks.finalize).toHaveBeenCalledWith(
      repo.path,
      expect.any(String),
      '/workspace/final',
      'feature/test',
      'main',
      undefined,
      {},
      mocks.prepareCheckout.mock.calls[0]?.[3]
    )
  })

  it('refuses a same-family retarget whose bases have drifted too far apart', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    // An abandoned fork's `main` is the same base family but a whole-tree checkout away.
    mocks.measureDivergence.mockResolvedValue('exceeded')

    await expect(
      consumePreparedWorktreeCreate({
        repoPath: repo.path,
        workspaceRoot: '/workspace',
        worktreePath: '/workspace/final',
        branch: 'feature/test',
        baseBranch: 'main'
      })
    ).resolves.toEqual({ status: 'miss', reason: 'retarget_too_divergent' })
    expect(mocks.finalize).not.toHaveBeenCalled()
    // The preparation is left armed for the base it actually holds.
    expect(mocks.discard).not.toHaveBeenCalled()
  })

  it('separates a drift check that said no from one that could not answer', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    // A timed-out or aborted walk skipped a retarget that may well have been cheap; that is a
    // tuning signal, not the bound working as intended, so it must not report as excess drift.
    mocks.measureDivergence.mockResolvedValue('unknown')

    await expect(
      consumePreparedWorktreeCreate({
        repoPath: repo.path,
        workspaceRoot: '/workspace',
        worktreePath: '/workspace/final',
        branch: 'feature/test',
        baseBranch: 'main'
      })
    ).resolves.toEqual({ status: 'miss', reason: 'retarget_unverifiable' })
    expect(mocks.finalize).not.toHaveBeenCalled()
    expect(mocks.discard).not.toHaveBeenCalled()
  })

  it('does not spend a divergence walk when the base matches exactly', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')

    await consumePreparedWorktreeCreate({
      repoPath: repo.path,
      workspaceRoot: '/workspace',
      worktreePath: '/workspace/final',
      branch: 'feature/test',
      baseBranch: 'origin/main'
    })

    expect(mocks.measureDivergence).not.toHaveBeenCalled()
  })

  it('claims when the two sides spell the same ref differently', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')

    await expect(
      consumePreparedWorktreeCreate({
        repoPath: repo.path,
        workspaceRoot: '/workspace',
        worktreePath: '/workspace/final',
        branch: 'feature/test',
        baseBranch: 'refs/remotes/origin/main'
      })
    ).resolves.toEqual({
      status: 'hit',
      retargeted: false,
      reset: 'none',
      buildMs: expect.any(Number),
      idleMs: expect.any(Number),
      origin: 'prefetch',
      result: {},
      rearm: expect.any(Function)
    })
  })

  it('never hands the same prepared checkout to two concurrent creates', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')

    // `main` needs the ref probe, so the claim has to await mid-flight — the window where a
    // second create could otherwise walk away with the same preparation.
    const [first, second] = await Promise.all([
      consumePreparedWorktreeCreate({
        repoPath: repo.path,
        workspaceRoot: '/workspace',
        worktreePath: '/workspace/first',
        branch: 'feature/first',
        baseBranch: 'main'
      }),
      consumePreparedWorktreeCreate({
        repoPath: repo.path,
        workspaceRoot: '/workspace',
        worktreePath: '/workspace/second',
        branch: 'feature/second',
        baseBranch: 'main'
      })
    ])

    expect([first.status, second.status]).toContain('hit')
    const preparedPaths = mocks.finalize.mock.calls.map((call) => call[1])
    expect(new Set(preparedPaths).size).toBe(preparedPaths.length)
  })

  it('reports which part of the claim key disagreed', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')

    await expect(
      consumePreparedWorktreeCreate({
        repoPath: repo.path,
        workspaceRoot: '/other-workspace',
        worktreePath: '/other-workspace/final',
        branch: 'feature/test',
        baseBranch: 'origin/main'
      })
    ).resolves.toEqual({ status: 'miss', reason: 'workspace_root_mismatch' })

    await expect(
      consumePreparedWorktreeCreate({
        repoPath: repo.path,
        workspaceRoot: '/workspace',
        worktreePath: '/workspace/final',
        branch: 'feature/test',
        baseBranch: 'origin/main',
        options: { wslDistro: 'Ubuntu' }
      })
    ).resolves.toEqual({ status: 'miss', reason: 'wsl_distro_mismatch' })

    await expect(
      consumePreparedWorktreeCreate({
        repoPath: '/other-repo',
        workspaceRoot: '/workspace',
        worktreePath: '/workspace/final',
        branch: 'feature/test',
        baseBranch: 'origin/main'
      })
    ).resolves.toEqual({ status: 'miss', reason: 'repo_mismatch' })
    expect(mocks.finalize).not.toHaveBeenCalled()
  })

  it("evicts a repo's own stale preparation before another repo's", async () => {
    const otherRepo = { id: 'repo-2', path: '/other-repo' } as Repo
    await prepareWorktreeCreateForRepo(store, otherRepo, 'origin/main')
    // Fill the pool from one repo, as flipping the composer's base picker does, until the next
    // arm has to evict something.
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    await prepareWorktreeCreateForRepo(store, repo, 'origin/release')
    await prepareWorktreeCreateForRepo(store, repo, 'main')

    // The eviction must cost `repo` a slot, not `otherRepo` its warm checkout.
    await expect(
      consumePreparedWorktreeCreate({
        repoPath: otherRepo.path,
        workspaceRoot: '/workspace',
        worktreePath: '/workspace/other',
        branch: 'feature/other',
        baseBranch: 'origin/main'
      })
    ).resolves.toMatchObject({ status: 'hit' })
  })

  it('routes preparation and finalization through the selected WSL runtime', async () => {
    const options = { wslDistro: 'Ubuntu' }
    mocks.getWorktreeOptions.mockReturnValue(options)
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')

    await consumePreparedWorktreeCreate({
      repoPath: repo.path,
      workspaceRoot: '/workspace',
      worktreePath: '/workspace/final',
      branch: 'feature/test',
      baseBranch: 'origin/main',
      options
    })

    expect(mocks.prepareCheckout).toHaveBeenCalledWith(
      repo.path,
      expect.any(String),
      'refs/remotes/origin/main',
      expect.any(String),
      { ...options, signal: expect.any(AbortSignal) },
      undefined
    )
    expect(mocks.finalize).toHaveBeenCalledWith(
      repo.path,
      expect.any(String),
      '/workspace/final',
      'feature/test',
      'origin/main',
      undefined,
      options,
      mocks.prepareCheckout.mock.calls[0]?.[3]
    )
  })

  it('retries stale cleanup after a transient listing failure', async () => {
    mocks.listWorktreeGraph.mockRejectedValueOnce(new Error('temporary listing failure'))
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    await prepareWorktreeCreateForRepo(store, repo, 'origin/release')

    expect(mocks.listWorktreeGraph).toHaveBeenCalledTimes(2)
  })

  it('prepares while stale removal is stalled, shares its scan, and settles removal on reset', async () => {
    const stalePath = '/workspace/.orca-preparing/999999999-11111111-1111-4111-8111-111111111111'
    let releaseRemoval!: () => void
    const removal = new Promise<void>((resolve) => {
      releaseRemoval = resolve
    })
    mocks.listWorktreeGraph.mockResolvedValueOnce([
      {
        path: stalePath,
        branch: undefined,
        lockReason: 'orca-create-preparation:v1:999999999:stale',
        head: 'deadbeef',
        isBare: false,
        isMainWorktree: false
      }
    ])
    mocks.discard.mockImplementation((_repo, path) =>
      path === stalePath ? removal : Promise.resolve()
    )
    let ready = false
    let reset: Promise<void> | undefined
    const preparation = prepareWorktreeCreateForRepo(store, repo, 'origin/main').then(() => {
      ready = true
    })
    try {
      await flushBackgroundWork()
      expect(mocks.discard).toHaveBeenCalledWith(
        repo.path,
        stalePath,
        {
          admissionTier: 'background'
        },
        'orca-create-preparation:v1:999999999:stale'
      )
      expect(ready).toBe(true)
      await prepareWorktreeCreateForRepo(store, repo, 'origin/release')
      expect(mocks.prepareCheckout).toHaveBeenCalledTimes(2)
      expect(mocks.listWorktreeGraph).toHaveBeenCalledTimes(1)
      expect(hasPendingStalePreparationCleanup()).toBe(true)
      mocks.getWorktreeOptions.mockReturnValue({ wslDistro: 'Ubuntu' })
      await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
      expect(mocks.prepareCheckout).toHaveBeenCalledTimes(3)
      expect(mocks.listWorktreeGraph).toHaveBeenCalledTimes(2)
      expect(mocks.listWorktreeGraph).toHaveBeenLastCalledWith(repo.path, {
        wslDistro: 'Ubuntu',
        includeCreatePreparations: true
      })
      let resetFinished = false
      reset = _resetWorktreeCreatePreparationsForTests().then(() => {
        resetFinished = true
      })
      await flushBackgroundWork()
      expect(resetFinished).toBe(false)
    } finally {
      releaseRemoval()
      await preparation
      await reset
    }
    expect(hasPendingStalePreparationCleanup()).toBe(false)
  })

  it('unlocks a stale branch-attached final path instead of deleting user work', async () => {
    mocks.listWorktreeGraph.mockResolvedValueOnce([
      {
        path: '/workspace/final',
        branch: 'refs/heads/feature/test',
        lockReason: 'orca-create-preparation:v1:999999999:stale',
        head: 'deadbeef',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')

    expect(mocks.unlock).toHaveBeenCalledWith(
      repo.path,
      '/workspace/final',
      { admissionTier: 'background' },
      'orca-create-preparation:v1:999999999:stale'
    )
    expect(mocks.discard).not.toHaveBeenCalledWith(repo.path, '/workspace/final', expect.anything())
  })

  it('does not classify a user branch worktree under the preparation directory as stale', async () => {
    mocks.listWorktreeGraph.mockResolvedValueOnce([
      {
        path: '/workspace/.orca-preparing/999999999-user-worktree',
        branch: 'refs/heads/user-worktree',
        lockReason: undefined,
        head: 'deadbeef',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')

    expect(mocks.unlock).not.toHaveBeenCalled()
    expect(mocks.discard).not.toHaveBeenCalled()
  })

  it('does not discard a detached worktree with caller-controlled preparation metadata', async () => {
    mocks.listWorktreeGraph.mockResolvedValueOnce([
      {
        path: `/workspace/${WORKTREE_CREATE_PREPARATION_DIRECTORY}/999-checkout`,
        branch: undefined,
        lockReason: 'orca-create-preparation:v1:999999999:spoofed',
        head: 'deadbeef',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')

    expect(mocks.discard).not.toHaveBeenCalledWith(
      repo.path,
      `/workspace/${WORKTREE_CREATE_PREPARATION_DIRECTORY}/999-checkout`,
      {}
    )
  })

  it('cleans up and reports a finalize miss so normal add can run', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    mocks.finalize.mockRejectedValueOnce(new Error('submodules prevent worktree move'))

    await expect(
      consumePreparedWorktreeCreate({
        repoPath: repo.path,
        workspaceRoot: '/workspace',
        worktreePath: '/workspace/final',
        branch: 'feature/test',
        baseBranch: 'origin/main'
      })
    ).resolves.toMatchObject({ status: 'miss', reason: 'finalize_failed' })
    expect(mocks.mkdir).toHaveBeenCalledWith('/workspace', { recursive: true })
    expect(mocks.discard).toHaveBeenCalledTimes(1)
  })

  it('preserves another owner’s checkout when finalization loses its lock', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    mocks.finalize.mockRejectedValueOnce(new WorktreePreparationLockOwnershipError())
    await expect(
      consumePreparedWorktreeCreate({
        repoPath: repo.path,
        workspaceRoot: '/workspace',
        worktreePath: '/workspace/final',
        branch: 'feature/test',
        baseBranch: 'origin/main'
      })
    ).resolves.toMatchObject({ status: 'miss', reason: 'finalize_failed' })
    expect(mocks.discard).not.toHaveBeenCalled()
  })

  /** Mirrors a real create: consume, then run the deferred re-arm once the create has returned. */
  async function consumeOnce(name: string): Promise<void> {
    const attempt = await consumePreparedWorktreeCreate({
      repoPath: repo.path,
      workspaceRoot: '/workspace',
      worktreePath: `/workspace/${name}`,
      branch: `feature/${name}`,
      baseBranch: 'origin/main'
    })
    if (attempt.status === 'hit') {
      attempt.rearm()
    }
  }

  it('does not re-arm after an isolated create', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    await consumeOnce('only')

    // Why: a lone create would otherwise leave a full spare checkout on disk for the whole TTL.
    expect(mocks.prepareCheckout).toHaveBeenCalledTimes(1)
  })

  it('re-arms a preparation once creates arrive in a burst', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    await consumeOnce('first')
    expect(mocks.prepareCheckout).toHaveBeenCalledTimes(1)

    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    await consumeOnce('second')
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')

    expect(mocks.prepareCheckout).toHaveBeenCalledTimes(3)
    // The replacement is claimable, so a third create still skips the cold add.
    await expect(
      consumePreparedWorktreeCreate({
        repoPath: repo.path,
        workspaceRoot: '/workspace',
        worktreePath: '/workspace/third',
        branch: 'feature/third',
        baseBranch: 'origin/main'
      })
    ).resolves.toEqual({
      status: 'hit',
      retargeted: false,
      reset: 'none',
      buildMs: expect.any(Number),
      idleMs: expect.any(Number),
      // Built by the burst re-arm after the second create; the prefetch after it asked for it too.
      origin: 'rearm_then_prefetch',
      result: {},
      rearm: expect.any(Function)
    })
    expect(mocks.finalize).toHaveBeenCalledTimes(3)
  })

  it('holds the re-arm checkout until the create runs the deferred thunk', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    await consumeOnce('first')
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    mocks.prepareCheckout.mockClear()

    const attempt = await consumePreparedWorktreeCreate({
      repoPath: repo.path,
      workspaceRoot: '/workspace',
      worktreePath: '/workspace/second',
      branch: 'feature/second',
      baseBranch: 'origin/main'
    })

    // Drained first: an eager re-arm reaches prepareCheckout only after the pool awaits stale
    // cleanup, so asserting in the same turn would pass with the deferral removed.
    await flushBackgroundWork()
    // The replacement checkout would otherwise hold a git admission slot for the rest of the create.
    expect(mocks.prepareCheckout).not.toHaveBeenCalled()
    expect(attempt.status).toBe('hit')
    if (attempt.status === 'hit') {
      attempt.rearm()
    }
    await flushBackgroundWork()
    expect(mocks.prepareCheckout).toHaveBeenCalledTimes(1)
  })

  it('starts one explicit prefetch after the create completes', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    await consumeOnce('first')
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')

    const attempt = await consumePreparedWorktreeCreate({
      repoPath: repo.path,
      workspaceRoot: '/workspace',
      worktreePath: '/workspace/second',
      branch: 'feature/second',
      baseBranch: 'origin/main'
    })
    expect(attempt.status).toBe('hit')

    // The user reopens the composer while the create is still finishing.
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    expect(mocks.prepareCheckout).toHaveBeenCalledTimes(2)
    mocks.prepareCheckout.mockClear()

    if (attempt.status === 'hit') {
      attempt.rearm()
    }
    await flushBackgroundWork()

    expect(mocks.prepareCheckout).toHaveBeenCalledTimes(1)
  })

  it('does not re-arm when finalization failed', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    await consumeOnce('first')
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    mocks.prepareCheckout.mockClear()
    mocks.finalize.mockRejectedValueOnce(new Error('submodules prevent worktree move'))

    await consumeOnce('second')

    expect(mocks.prepareCheckout).not.toHaveBeenCalled()
  })

  it('reports a pending create while a stale-cleanup scan is running', async () => {
    let releaseListing!: () => void
    mocks.listWorktreeGraph.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseListing = () => resolve([])
      })
    )
    const arming = prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    // Anchor on the scan actually starting, not on a fixed number of microtasks: an await added
    // ahead of it would otherwise make this pass vacuously rather than fail.
    while (mocks.listWorktreeGraph.mock.calls.length === 0) {
      await Promise.resolve()
    }

    // Why: the idle gate must not start repo maintenance while crash recovery is mid-scan.
    expect(hasPendingWorktreeCreatePreparations()).toBe(true)

    releaseListing()
    await arming
  })
})
