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

vi.mock('../../../workspaces/catalog/repo-worktrees', () => ({
  listRepoWorktreesForDetectedScan: listRepoWorktreesMock
}))
vi.mock('../../../workspaces/execution-host/project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: () => ({})
}))
vi.mock('../removal/registered-worktree-roots-cache', () => ({
  getRegisteredWorktreeRootsRevision: () => 1,
  registerWorktreeRootsForRepo: registerWorktreeRootsMock
}))
vi.mock('../../../workspaces/catalog/worktree-lineage-pruning', () => ({
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
const { setWorktreeCatalogRouteResolver } =
  await import('../../../workspaces/catalog/repo-worktree-catalog-route')
const { invalidateLocalWorktreeMetadataPruneInputs } =
  await import('../../../workspaces/catalog/local-worktree-metadata-prune-gate')

const repo = { id: 'repo-1', path: '/repos/one', displayName: 'one' } as Repo

function worktreeAt(path: string): GitWorktreeInfo {
  return { path, head: 'abc', branch: 'main', isBare: false, isMainWorktree: path === repo.path }
}

const captureExpectation = vi.fn(() => ({ repo: { id: repo.id }, metadata: [] }))
const store = { captureNativeLocalWorktreeMetadataScanExpectation: captureExpectation } as never

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

    // Model an external removal with no change notification.
    listRepoWorktreesMock.mockResolvedValue([worktreeAt(repo.path), worktreeAt('/repos/one-wt')])
    advancePastListingTtl()
    await listDetectedGitWorktrees(store, repo)

    advancePastListingTtl()
    expect((await listDetectedGitWorktrees(store, repo)).hygieneDue).toBe(true)
  })

  it('stops deleting once the owner retires the route during the prune helper', async () => {
    let live = true
    setWorktreeCatalogRouteResolver(() =>
      live ? { repoPath: repo.path, runtimeKey: 'local:default' } : null
    )
    try {
      const scan = await listDetectedGitWorktrees(store, repo)
      let helperSawCurrent: boolean | undefined
      pruneMetadataMock.mockImplementation(async (args: { isCallerCurrent: () => boolean }) => {
        live = false
        helperSawCurrent = args.isCallerCurrent()
        return { scanGenerationCurrent: true, preservedMetadataCandidateIds: new Set() }
      })

      const applied = await applyFreshDetectedWorktreeScanSideEffects(
        store,
        repo,
        scan.gitWorktrees,
        scan.metadataPrune,
        { sideEffectToken: scan.sideEffectToken, hygieneDue: scan.hygieneDue }
      )

      expect(helperSawCurrent).toBe(false)
      expect(applied).toBe(false)
      expect(pruneLineageMock).not.toHaveBeenCalled()
      expect(scan.authorityCurrent?.()).toBe(false)
    } finally {
      setWorktreeCatalogRouteResolver(null)
    }
  })
})
