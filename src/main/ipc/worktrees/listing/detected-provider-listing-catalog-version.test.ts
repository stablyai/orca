import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'

const { listRepoWorktreesMock } = vi.hoisted(() => ({ listRepoWorktreesMock: vi.fn() }))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  app: { getPath: () => '/tmp/orca-test' }
}))
vi.mock('../../../repo-worktrees', () => ({
  listRepoWorktreesForDetectedScan: listRepoWorktreesMock
}))
vi.mock('../../../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: () => ({})
}))
vi.mock('../../registered-worktree-roots-cache', () => ({
  getRegisteredWorktreeRootsRevision: () => 1,
  registerWorktreeRootsForRepo: vi.fn()
}))
vi.mock('../../../worktree-lineage-pruning', () => ({
  pruneLineageForMissingRepoWorktrees: vi.fn()
}))
vi.mock('./authoritative-local-worktree-metadata-pruning', () => ({
  pruneMetadataMissingFromAuthoritativeLocalScan: vi
    .fn()
    .mockResolvedValue({ scanGenerationCurrent: true, preservedMetadataCandidateIds: new Set() })
}))

const { listDetectedWorktreesForCapturedRepo } = await import('./detected-provider-listing')
const { __resetDetectedWorktreeScanCacheForTests, invalidateDetectedWorktreeScanCache } =
  await import('./detected-worktree-scan-cache')
const { getLocalWorktreeCatalogVersion, getLocalWorktreeScanGeneration } =
  await import('../../../local-worktree-scan-generation')

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listing reads only id, path, displayName and connectionId off the repo row.
const localRepo = { id: 'repo-local', path: '/repos/local', displayName: 'local' } as Repo

function createStore(repo: Repo) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listing reads only these store methods; the pruning that would need more is mocked above.
  return {
    getRepo: () => repo,
    getRepos: () => [repo],
    getProjects: () => [],
    getSettings: () => ({}),
    getAllWorktreeMeta: () => ({}),
    getProjectHostSetups: () => [],
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: vi.fn(),
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    removeWorktreeLineage: vi.fn(),
    captureNativeLocalWorktreeMetadataScanExpectation: () => undefined
  } as never
}

function worktreeAt(repo: Repo, path: string): GitWorktreeInfo {
  return { path, head: 'abc', branch: 'main', isBare: false, isMainWorktree: path === repo.path }
}

function listLocal() {
  return listDetectedWorktreesForCapturedRepo(createStore(localRepo), localRepo, () => true)
}

// Why this suite exists: a client orders listings against the create and remove replies it has
// applied, so a listing must name the catalog its scan began at, not the one current when the
// reply was assembled.
describe('the catalog version a listing carries', () => {
  beforeEach(() => {
    __resetDetectedWorktreeScanCacheForTests()
    listRepoWorktreesMock.mockReset()
  })

  it('is the generation the local scan began at, and a change bumps the current one past it', async () => {
    listRepoWorktreesMock.mockResolvedValue([worktreeAt(localRepo, localRepo.path)])
    const atScanStart = getLocalWorktreeScanGeneration(localRepo.id)

    const listing = await listLocal()

    expect(listing).toMatchObject({ authoritative: true })
    expect(listing && 'catalogVersion' in listing ? listing.catalogVersion : undefined).toEqual(
      getLocalWorktreeCatalogVersion(localRepo.id)
    )
    expect(listing && 'catalogVersion' in listing ? listing.catalogVersion?.sequence : -1).toBe(
      atScanStart
    )

    invalidateDetectedWorktreeScanCache(localRepo.id)
    const afterChange = getLocalWorktreeCatalogVersion(localRepo.id)
    expect(afterChange.sequence).toBeGreaterThan(atScanStart)
    expect(afterChange.epoch).toBe(
      listing && 'catalogVersion' in listing ? listing.catalogVersion?.epoch : undefined
    )
  })

  it("is the cached scan's own generation when the cache answers", async () => {
    listRepoWorktreesMock.mockResolvedValue([worktreeAt(localRepo, localRepo.path)])
    const first = await listLocal()
    const second = await listLocal()

    expect(listRepoWorktreesMock).toHaveBeenCalledTimes(1)
    expect(second && 'catalogVersion' in second ? second.catalogVersion : undefined).toEqual(
      first && 'catalogVersion' in first ? first.catalogVersion : undefined
    )
  })

  it('a create reply issued after the change names a later catalog than the listing', async () => {
    listRepoWorktreesMock.mockResolvedValue([worktreeAt(localRepo, localRepo.path)])
    const listing = await listLocal()
    // The create's own change notification bumps the generation before the reply is stamped.
    invalidateDetectedWorktreeScanCache(localRepo.id)
    const createReply = getLocalWorktreeCatalogVersion(localRepo.id)

    const listed = listing && 'catalogVersion' in listing ? listing.catalogVersion : undefined
    expect(listed?.epoch).toBe(createReply.epoch)
    expect(listed!.sequence).toBeLessThan(createReply.sequence)
  })
})
