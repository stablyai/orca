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

const localRepo: Repo = {
  id: 'repo-local',
  path: '/repos/local',
  displayName: 'local',
  badgeColor: '#000',
  addedAt: 0
}

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

function deferredListing(): {
  promise: Promise<GitWorktreeInfo[]>
  settle: (rows: GitWorktreeInfo[]) => void
} {
  let settle!: (rows: GitWorktreeInfo[]) => void
  const promise = new Promise<GitWorktreeInfo[]>((resolve) => {
    settle = resolve
  })
  return { promise, settle }
}

type ListingBranch = {
  repo: Repo
  listMock: ReturnType<typeof vi.fn>
  list: () => ReturnType<typeof listDetectedWorktreesForCapturedRepo>
}

const branches: [string, () => ListingBranch][] = [
  [
    'local (through the scan cache)',
    () => ({
      repo: localRepo,
      listMock: listRepoWorktreesMock,
      list: () =>
        listDetectedWorktreesForCapturedRepo(createStore(localRepo), localRepo, () => true)
    })
  ]
]

// An overtaken scan misses newly created rows; re-scan before clients interpret their absence as deletion.
describe.each(branches)(
  'detected listing overtaken by a worktree mutation: %s',
  (_name, branch) => {
    beforeEach(() => {
      listRepoWorktreesMock.mockReset()
      __resetDetectedWorktreeScanCacheForTests()
    })

    it('re-runs the scan and answers authoritative from the re-run', async () => {
      const { repo, listMock, list } = branch()
      const inFlight = deferredListing()
      listMock
        .mockReturnValueOnce(inFlight.promise)
        .mockResolvedValueOnce([worktreeAt(repo, repo.path), worktreeAt(repo, '/created')])

      const pending = list()
      await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))
      // Model create notification while the first listing is in flight.
      invalidateDetectedWorktreeScanCache(repo.id)
      inFlight.settle([worktreeAt(repo, repo.path)])

      const result = await pending

      expect(listMock).toHaveBeenCalledTimes(2)
      expect(result).toMatchObject({
        authoritative: true,
        source: 'git',
        worktrees: [
          expect.objectContaining({ path: repo.path }),
          expect.objectContaining({ path: '/created' })
        ]
      })
    })

    it('answers stale once the bound is spent under continuous churn', async () => {
      const { repo, listMock, list } = branch()
      listMock.mockImplementation(async () => {
        invalidateDetectedWorktreeScanCache(repo.id)
        return [worktreeAt(repo, repo.path)]
      })

      const result = await list()

      expect(listMock).toHaveBeenCalledTimes(3)
      expect(result).toBeNull()
    })

    it('does not re-run a scan nothing overtook', async () => {
      const { repo, listMock, list } = branch()
      listMock.mockResolvedValue([worktreeAt(repo, repo.path)])

      const result = await list()

      expect(listMock).toHaveBeenCalledTimes(1)
      expect(result).toMatchObject({ authoritative: true, source: 'git' })
    })
  }
)
