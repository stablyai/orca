import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import { WORKTREE_CREATE_PREPARATION_DIRECTORY } from '../shared/worktree/create-preparation'
import { resolveWorktreeAddBaseRef } from '../shared/worktree/base-ref'

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  listWorktreeGraph: vi.fn(),
  prepareCheckout: vi.fn(),
  finalize: vi.fn(),
  discard: vi.fn(),
  unlock: vi.fn(),
  getWorktreeOptions: vi.fn(),
  computeWorkspaceRoot: vi.fn(),
  computeWorkspaceRootAsync: vi.fn(),
  resolveBaseRef: vi.fn(),
  measureDivergence: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ mkdir: mocks.mkdir }))
vi.mock('./git/worktree', () => ({ listWorktreeGraph: mocks.listWorktreeGraph }))
vi.mock('./git/worktree-create-preparation', () => ({
  prepareWorktreeCreateCheckout: mocks.prepareCheckout,
  finalizePreparedWorktree: mocks.finalize,
  discardPreparedWorktree: mocks.discard,
  unlockPreparedWorktree: mocks.unlock
}))
vi.mock('./git/worktree-base-ref-probe', () => ({
  resolveLocalWorktreeBaseRef: mocks.resolveBaseRef
}))
vi.mock('./git/worktree-base-divergence', () => ({
  measureRetargetDivergence: mocks.measureDivergence
}))
vi.mock('./project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: mocks.getWorktreeOptions,
  getWorktreeMirrorDistro: () => undefined
}))
vi.mock('./ipc/worktree-logic', () => ({
  computeWorkspaceRoot: mocks.computeWorkspaceRoot,
  computeWorkspaceRootAsync: mocks.computeWorkspaceRootAsync,
  getWorktreePathSettings: () => ({
    workspaceDir: process.platform === 'win32' ? 'C:\\workspace' : '/workspace',
    nestWorkspaces: false
  })
}))

import {
  _resetWorktreeCreatePreparationsForTests,
  consumePreparedWorktreeCreate,
  hasPendingWorktreeCreatePreparations,
  prepareWorktreeCreateForRepo
} from './worktree-create-preparation'

// Evictions and retries are fire-and-forget, so let them settle before asserting.
function flushBackgroundWork(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const EXISTING_REFS = new Set([
  'refs/heads/main',
  'refs/remotes/origin/main',
  'refs/remotes/origin/release'
])
const repo = { id: 'repo-1', path: '/repo' } as Repo
const store = { getSettings: () => ({}) } as unknown as Store

beforeEach(() => {
  mocks.mkdir.mockReset().mockResolvedValue(undefined)
  mocks.listWorktreeGraph.mockReset().mockResolvedValue([])
  mocks.prepareCheckout.mockReset().mockResolvedValue(undefined)
  mocks.finalize.mockReset().mockResolvedValue({})
  mocks.discard.mockReset().mockResolvedValue(undefined)
  mocks.unlock.mockReset().mockResolvedValue(undefined)
  mocks.getWorktreeOptions.mockReset().mockReturnValue({})
  mocks.measureDivergence.mockReset().mockResolvedValue('within')
  mocks.resolveBaseRef
    .mockReset()
    .mockImplementation((_repoPath: string, baseRef: string) =>
      resolveWorktreeAddBaseRef(baseRef, async (candidate) => EXISTING_REFS.has(candidate))
    )
  mocks.computeWorkspaceRoot.mockReset().mockImplementation(() => {
    throw new Error('synchronous workspace-root lookup must not run on the main thread')
  })
  mocks.computeWorkspaceRootAsync
    .mockReset()
    .mockImplementation(async (repoPath: string) =>
      process.platform === 'win32' && /^[A-Za-z]:[\\/]/.test(repoPath)
        ? 'C:\\workspace'
        : '/workspace'
    )
})

afterEach(async () => {
  await _resetWorktreeCreatePreparationsForTests()
})

describe('worktree create preparation registry', () => {
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
    ).resolves.toEqual({ status: 'hit', retargeted: true, result: {} })
    // Finalize still receives the requested base, so it resets onto the requested commit.
    expect(mocks.finalize).toHaveBeenCalledWith(
      repo.path,
      expect.any(String),
      '/workspace/final',
      'feature/test',
      'main',
      undefined,
      {}
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
    ).resolves.toEqual({ status: 'hit', retargeted: false, result: {} })
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
      options
    )
    expect(mocks.finalize).toHaveBeenCalledWith(
      repo.path,
      expect.any(String),
      '/workspace/final',
      'feature/test',
      'origin/main',
      undefined,
      options
    )
  })

  it('retries stale cleanup after a transient listing failure', async () => {
    mocks.listWorktreeGraph.mockRejectedValueOnce(new Error('temporary listing failure'))
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    await prepareWorktreeCreateForRepo(store, repo, 'origin/release')

    expect(mocks.listWorktreeGraph).toHaveBeenCalledTimes(2)
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

    expect(mocks.unlock).toHaveBeenCalledWith(repo.path, '/workspace/final', {})
    expect(mocks.discard).not.toHaveBeenCalledWith(repo.path, '/workspace/final', {})
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
    ).resolves.toEqual({ status: 'miss', reason: 'finalize_failed' })
    expect(mocks.mkdir).toHaveBeenCalledWith('/workspace', { recursive: true })
    expect(mocks.discard).toHaveBeenCalledTimes(1)
  })

  async function consumeOnce(name: string): Promise<void> {
    await consumePreparedWorktreeCreate({
      repoPath: repo.path,
      workspaceRoot: '/workspace',
      worktreePath: `/workspace/${name}`,
      branch: `feature/${name}`,
      baseBranch: 'origin/main'
    })
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
    ).resolves.toEqual({ status: 'hit', retargeted: false, result: {} })
    expect(mocks.finalize).toHaveBeenCalledTimes(3)
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

  it('retries a discard that failed while this process is still alive', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const leakedPath = mocks.prepareCheckout.mock.calls[0][1] as string
    mocks.discard.mockRejectedValueOnce(new Error('EBUSY'))

    // Fill the registry so the first preparation is evicted while its owner pid is still alive.
    for (const base of ['origin/one', 'origin/two', 'origin/three']) {
      await prepareWorktreeCreateForRepo(store, repo, base)
    }
    await flushBackgroundWork()
    expect(mocks.discard).toHaveBeenCalledWith(repo.path, leakedPath, {})

    mocks.discard.mockClear()
    await prepareWorktreeCreateForRepo(store, repo, 'origin/four')
    await flushBackgroundWork()
    expect(mocks.discard).toHaveBeenCalledWith(repo.path, leakedPath, {})

    mocks.discard.mockClear()
    await prepareWorktreeCreateForRepo(store, repo, 'origin/five')
    await flushBackgroundWork()
    expect(mocks.discard).not.toHaveBeenCalledWith(repo.path, leakedPath, {})
  })

  it('retries only the leaked paths belonging to the host being prepared', async () => {
    const otherRepo = { ...repo, id: 'repo-2', path: '/other-repo' } as Repo
    const unremovable = new Set<string>()
    mocks.discard.mockImplementation(async (_repoPath: string, path: string) => {
      if (unremovable.has(path)) {
        throw new Error('EBUSY')
      }
    })

    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const leakedHere = mocks.prepareCheckout.mock.calls[0][1] as string
    await prepareWorktreeCreateForRepo(store, otherRepo, 'origin/main')
    const leakedElsewhere = mocks.prepareCheckout.mock.calls[1][1] as string
    unremovable.add(leakedHere)
    unremovable.add(leakedElsewhere)

    // Evict through each host's own arming: eviction prefers the incoming workspace's oldest
    // entry, so preparing for `repo` no longer reaches across and takes `otherRepo`'s.
    for (const base of ['origin/one', 'origin/two']) {
      await prepareWorktreeCreateForRepo(store, repo, base)
    }
    for (const base of ['origin/one', 'origin/two']) {
      await prepareWorktreeCreateForRepo(store, otherRepo, base)
    }
    await flushBackgroundWork()
    expect(mocks.discard).toHaveBeenCalledWith(repo.path, leakedHere, {})
    expect(mocks.discard).toHaveBeenCalledWith(otherRepo.path, leakedElsewhere, {})

    mocks.discard.mockClear()
    await prepareWorktreeCreateForRepo(store, repo, 'origin/four')
    await flushBackgroundWork()
    expect(mocks.discard).toHaveBeenCalledWith(repo.path, leakedHere, {})
    expect(mocks.discard.mock.calls.some((call) => call[1] === leakedElsewhere)).toBe(false)
  })

  it('stops retrying a preparation that never becomes removable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
      const leakedPath = mocks.prepareCheckout.mock.calls[0][1] as string
      mocks.discard.mockImplementation(async (_repoPath: string, path: string) => {
        if (path === leakedPath) {
          throw new Error('EBUSY')
        }
      })
      const leakedDiscards = (): number =>
        mocks.discard.mock.calls.filter((call) => call[1] === leakedPath).length

      for (const base of ['origin/one', 'origin/two', 'origin/three']) {
        await prepareWorktreeCreateForRepo(store, repo, base)
      }
      await flushBackgroundWork()
      expect(leakedDiscards()).toBe(1)

      for (const base of ['origin/four', 'origin/five', 'origin/six']) {
        await prepareWorktreeCreateForRepo(store, repo, base)
        await flushBackgroundWork()
      }
      expect(leakedDiscards()).toBe(3)
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`could not be discarded in 3 attempts; ${leakedPath}`),
        expect.any(Error)
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('retries a failed checkout whose own self-discard also left the path registered', async () => {
    let failCheckout!: (error: Error) => void
    mocks.prepareCheckout.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          failCheckout = reject
        })
    )
    const failing = prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    await flushBackgroundWork()
    const leakedPath = mocks.prepareCheckout.mock.calls[0][1] as string

    // Evict it while its checkout is still in flight, so discardEntry runs on a failed preparation.
    for (const base of ['origin/one', 'origin/two', 'origin/three']) {
      await prepareWorktreeCreateForRepo(store, repo, base)
    }
    mocks.discard.mockRejectedValueOnce(new Error('EBUSY'))
    failCheckout(new Error('worktree add failed'))
    await failing.catch(() => {})
    await flushBackgroundWork()
    expect(mocks.discard).toHaveBeenCalledWith(repo.path, leakedPath, {})

    mocks.discard.mockClear()
    await prepareWorktreeCreateForRepo(store, repo, 'origin/four')
    await flushBackgroundWork()
    expect(mocks.discard).toHaveBeenCalledWith(repo.path, leakedPath, {})
  })

  it('scopes retries to the WSL distro whose preparation leaked', async () => {
    const unremovable = new Set<string>()
    mocks.discard.mockImplementation(async (_repoPath: string, path: string) => {
      if (unremovable.has(path)) {
        throw new Error('EBUSY')
      }
    })

    mocks.getWorktreeOptions.mockReturnValue({ wslDistro: 'Ubuntu' })
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const leakedOnUbuntu = mocks.prepareCheckout.mock.calls[0][1] as string
    mocks.getWorktreeOptions.mockReturnValue({ wslDistro: 'Debian' })
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const leakedOnDebian = mocks.prepareCheckout.mock.calls[1][1] as string
    unremovable.add(leakedOnUbuntu)
    unremovable.add(leakedOnDebian)

    // Evict through each distro's own arming: the eviction scope includes the distro, so arming
    // under Ubuntu no longer reaches across and takes the Debian entry.
    mocks.getWorktreeOptions.mockReturnValue({ wslDistro: 'Ubuntu' })
    for (const base of ['origin/one', 'origin/two']) {
      await prepareWorktreeCreateForRepo(store, repo, base)
    }
    mocks.getWorktreeOptions.mockReturnValue({ wslDistro: 'Debian' })
    await prepareWorktreeCreateForRepo(store, repo, 'origin/one')
    mocks.getWorktreeOptions.mockReturnValue({ wslDistro: 'Ubuntu' })
    await flushBackgroundWork()
    expect(mocks.discard).toHaveBeenCalledWith(repo.path, leakedOnUbuntu, { wslDistro: 'Ubuntu' })
    expect(mocks.discard).toHaveBeenCalledWith(repo.path, leakedOnDebian, { wslDistro: 'Debian' })

    mocks.discard.mockClear()
    await prepareWorktreeCreateForRepo(store, repo, 'origin/four')
    await flushBackgroundWork()
    expect(mocks.discard).toHaveBeenCalledWith(repo.path, leakedOnUbuntu, { wslDistro: 'Ubuntu' })
    expect(mocks.discard.mock.calls.some((call) => call[1] === leakedOnDebian)).toBe(false)
  })

  it('drops recorded discards when the registry is reset for tests', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const leakedPath = mocks.prepareCheckout.mock.calls[0][1] as string
    // Reject on a real timer so the fire-and-forget discard is still in flight at reset.
    mocks.discard.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      throw new Error('EBUSY')
    })

    for (const base of ['origin/one', 'origin/two', 'origin/three']) {
      await prepareWorktreeCreateForRepo(store, repo, base)
    }
    await _resetWorktreeCreatePreparationsForTests()
    // Past the rejection timer: the reset must have absorbed the failure, not raced ahead of it.
    await flushBackgroundWork(20)

    mocks.discard.mockClear()
    await prepareWorktreeCreateForRepo(store, repo, 'origin/four')
    await flushBackgroundWork()
    expect(mocks.discard).not.toHaveBeenCalledWith(repo.path, leakedPath, {})
  })

  it("settles an evicted preparation's discard before the reset drops the registry", async () => {
    let failCheckout!: (error: Error) => void
    mocks.prepareCheckout.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          failCheckout = reject
        })
    )
    const failing = prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    await flushBackgroundWork()
    const leakedPath = mocks.prepareCheckout.mock.calls[0][1] as string
    mocks.discard.mockImplementation(async (_repoPath: string, path: string) => {
      if (path === leakedPath) {
        throw new Error('EBUSY')
      }
    })

    for (const base of ['origin/one', 'origin/two', 'origin/three']) {
      await prepareWorktreeCreateForRepo(store, repo, base)
    }
    // The eviction's discard is still parked on the checkout, so the reset has to wait for it.
    const reset = _resetWorktreeCreatePreparationsForTests()
    await flushBackgroundWork(5)
    failCheckout(new Error('worktree add failed'))
    await failing.catch(() => {})
    await reset
    await flushBackgroundWork(5)

    mocks.discard.mockClear()
    await prepareWorktreeCreateForRepo(store, repo, 'origin/four')
    await flushBackgroundWork()
    expect(mocks.discard).not.toHaveBeenCalledWith(repo.path, leakedPath, {})
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
