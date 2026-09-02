import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'

const { listRepoWorktreesMock, pruneLineageMock, pruneMetadataMock, registerWorktreeRootsMock } =
  vi.hoisted(() => ({
    listRepoWorktreesMock: vi.fn(),
    pruneLineageMock: vi.fn(),
    pruneMetadataMock: vi.fn(),
    registerWorktreeRootsMock: vi.fn()
  }))

vi.mock('../../../repo-worktrees', () => ({ listRepoWorktrees: listRepoWorktreesMock }))
vi.mock('../../../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: () => ({})
}))
vi.mock('../../registered-worktree-roots-cache', () => ({
  getRegisteredWorktreeRootsRevision: () => 1,
  registerWorktreeRootsForRepo: registerWorktreeRootsMock
}))
vi.mock('../../../worktree-lineage-pruning', () => ({
  pruneLineageForMissingRepoWorktrees: pruneLineageMock
}))
vi.mock('./authoritative-local-worktree-metadata-pruning', () => ({
  pruneMetadataMissingFromAuthoritativeLocalScan: pruneMetadataMock
}))

const {
  DETECTED_WORKTREE_SCAN_CACHE_TTL_MS,
  __resetDetectedWorktreeScanCacheForTests,
  applyFreshDetectedWorktreeScanSideEffects,
  invalidateDetectedWorktreeScanCache,
  listDetectedGitWorktrees
} = await import('./detected-worktree-scan-cache')
const { invalidateLocalWorktreeMetadataPruneInputs } =
  await import('../../../local-worktree-metadata-prune-gate')

const repo = { id: 'repo-1', path: '/repos/one', displayName: 'one' } as Repo

function worktreeAt(path: string): GitWorktreeInfo {
  return { path, head: 'abc', branch: 'main', isBare: false, isMainWorktree: path === repo.path }
}

const captureExpectation = vi.fn(() => ({ repo: { id: repo.id }, metadata: [] }))
const store = { captureNativeLocalWorktreeMetadataScanExpectation: captureExpectation } as never

/** Each listing must miss the TTL cache, the way a renderer poll past the window does. */
function advancePastListingTtl(): void {
  vi.setSystemTime(Date.now() + DETECTED_WORKTREE_SCAN_CACHE_TTL_MS + 1)
}

describe('detected worktree scan hygiene gate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    listRepoWorktreesMock.mockReset().mockResolvedValue([worktreeAt(repo.path)])
    captureExpectation.mockClear()
    pruneLineageMock.mockReset()
    pruneMetadataMock
      .mockReset()
      .mockResolvedValue({ scanGenerationCurrent: true, preservedMetadataCandidateIds: new Set() })
    registerWorktreeRootsMock.mockReset()
    __resetDetectedWorktreeScanCacheForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs hygiene once and then never again while nothing changes', async () => {
    const first = await listDetectedGitWorktrees(store, repo)
    expect(first.hygieneDue).toBe(true)
    expect(first.metadataPrune).toBeDefined()

    for (let poll = 0; poll < 20; poll += 1) {
      advancePastListingTtl()
      const scan = await listDetectedGitWorktrees(store, repo)
      expect(scan.fresh).toBe(true)
      expect(scan.hygieneDue).toBe(false)
      expect(scan.metadataPrune).toBeUndefined()
    }
    expect(captureExpectation).toHaveBeenCalledTimes(1)
  })

  it('still lists on every cache miss while hygiene is parked', async () => {
    await listDetectedGitWorktrees(store, repo)
    advancePastListingTtl()
    await listDetectedGitWorktrees(store, repo)

    expect(listRepoWorktreesMock).toHaveBeenCalledTimes(2)
  })

  it('re-runs hygiene after a worktree lifecycle event', async () => {
    await listDetectedGitWorktrees(store, repo)
    invalidateDetectedWorktreeScanCache(repo.id)

    expect((await listDetectedGitWorktrees(store, repo)).hygieneDue).toBe(true)
    expect(captureExpectation).toHaveBeenCalledTimes(2)
  })

  it('re-runs hygiene when ownership state may have released a row', async () => {
    await listDetectedGitWorktrees(store, repo)
    advancePastListingTtl()
    expect((await listDetectedGitWorktrees(store, repo)).hygieneDue).toBe(false)

    invalidateLocalWorktreeMetadataPruneInputs()

    advancePastListingTtl()
    expect((await listDetectedGitWorktrees(store, repo)).hygieneDue).toBe(true)
    expect(captureExpectation).toHaveBeenCalledTimes(2)
  })

  it('re-runs hygiene when the listing changes with no event to report it', async () => {
    await listDetectedGitWorktrees(store, repo)
    advancePastListingTtl()
    expect((await listDetectedGitWorktrees(store, repo)).hygieneDue).toBe(false)

    // An external `git worktree remove` nobody notified us about.
    listRepoWorktreesMock.mockResolvedValue([worktreeAt(repo.path), worktreeAt('/repos/one-wt')])
    advancePastListingTtl()
    await listDetectedGitWorktrees(store, repo)

    advancePastListingTtl()
    expect((await listDetectedGitWorktrees(store, repo)).hygieneDue).toBe(true)
  })

  it('skips both prune halves on a scan that does not own the hygiene pass', async () => {
    await applyFreshDetectedWorktreeScanSideEffects(
      store,
      repo,
      [worktreeAt(repo.path)],
      undefined,
      {
        hygieneDue: false
      }
    )

    expect(pruneMetadataMock).not.toHaveBeenCalled()
    expect(pruneLineageMock).not.toHaveBeenCalled()
    // Authorized roots are listing state, not hygiene; they must still be refreshed.
    expect(registerWorktreeRootsMock).toHaveBeenCalledTimes(1)
  })

  it('prunes lineage when the caller owns the hygiene pass', async () => {
    await applyFreshDetectedWorktreeScanSideEffects(
      store,
      repo,
      [worktreeAt(repo.path)],
      undefined,
      {
        hygieneDue: true
      }
    )

    expect(pruneLineageMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the eager behavior for callers that carry no gate', async () => {
    await applyFreshDetectedWorktreeScanSideEffects(store, repo, [worktreeAt(repo.path)])

    expect(pruneLineageMock).toHaveBeenCalledTimes(1)
  })
})
