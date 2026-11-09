import {
  mocks,
  repo,
  store,
  flushBackgroundWork
} from '../../../__mocks__/worktree-create-preparation'
import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { hasPendingStalePreparationCleanup } from './worktree-create-preparation-stale-cleanup'
import '../../../../shared/worktree/create-preparation'
import { WorktreePreparationLockOwnershipError } from '../../../git/worktrees/creation/worktree-preparation-lock'
import {
  _resetWorktreeCreatePreparationsForTests,
  consumePreparedWorktreeCreate,
  prepareWorktreeCreateForRepo
} from './worktree-create-preparation'
import { releaseWorktreeCreatePreparationsForRepo } from './worktree-create-preparation-project-removal'

describe('worktree create preparation registry', () => {
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

    // Different canonical refs leave only the branch-family retarget path.
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
      reset: 'none',
      buildMs: expect.any(Number),
      idleMs: expect.any(Number),
      origin: 'prefetch',
      result: {},
      rearm: expect.any(Function)
    })
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
    expect(mocks.discard).not.toHaveBeenCalled()
  })

  it('separates a drift check that said no from one that could not answer', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    // Unverifiable drift must not be reported as measured excess divergence.
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

  it('never hands the same prepared checkout to two concurrent creates', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')

    // The ref probe yields during claim, allowing a second create to race it.
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

  it("discards a removed project's armed checkout and reclaims its crash leftovers", async () => {
    const otherRepo = { id: 'repo-2', path: '/other-repo' } as Repo
    await prepareWorktreeCreateForRepo(store, otherRepo, 'origin/main')
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    await flushBackgroundWork()
    const armedPath = mocks.prepareCheckout.mock.calls[1]?.[1]
    const stalePath = '/workspace/.orca-preparing/999999999-11111111-1111-4111-8111-111111111111'
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

    releaseWorktreeCreatePreparationsForRepo(store, repo)
    await flushBackgroundWork()

    expect(mocks.discard).toHaveBeenCalledWith(
      repo.path,
      armedPath,
      expect.objectContaining({ signal: undefined }),
      expect.any(String)
    )
    expect(mocks.discard).toHaveBeenCalledWith(
      repo.path,
      stalePath,
      { admissionTier: 'background' },
      'orca-create-preparation:v1:999999999:stale'
    )
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
})
