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

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listing reads only id, path, displayName and connectionId off the repo row.
const localRepo = { id: 'repo-local', path: '/repos/local', displayName: 'local' } as Repo
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above; connectionId routes the listing to the provider branch.
const sshRepo = {
  id: 'repo-ssh',
  path: '/remote/repo',
  displayName: 'remote',
  connectionId: 'ssh-1'
} as Repo

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

/** A listing whose settlement the test controls, so a mutation can land while it is in flight. */
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

const sshListWorktrees = vi.fn()
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listing calls only listWorktrees on the captured provider.
const sshProvider = { listWorktrees: sshListWorktrees } as never

const branches: [string, () => ListingBranch][] = [
  [
    'local (through the scan cache)',
    () => ({
      repo: localRepo,
      listMock: listRepoWorktreesMock,
      list: () =>
        listDetectedWorktreesForCapturedRepo(createStore(localRepo), localRepo, () => true)
    })
  ],
  [
    'ssh (through the captured provider)',
    () => ({
      repo: sshRepo,
      listMock: sshListWorktrees,
      list: () =>
        listDetectedWorktreesForCapturedRepo(createStore(sshRepo), sshRepo, () => true, sshProvider)
    })
  ]
]

// Why this suite exists: a worktree created while a listing ran is absent from that listing, and an
// authoritative absence is a deletion to every client. The host re-runs the overtaken scan before it
// answers, and it does so under one rule for hosts with a scan cache and hosts without one.
describe.each(branches)(
  'detected listing overtaken by a worktree mutation: %s',
  (_name, branch) => {
    beforeEach(() => {
      listRepoWorktreesMock.mockReset()
      sshListWorktrees.mockReset()
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
      // The create finished while the scan ran: this is what every worktree change invalidator does.
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
