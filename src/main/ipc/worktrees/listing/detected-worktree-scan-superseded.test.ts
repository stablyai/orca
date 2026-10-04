import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'

const { listRepoWorktreesMock } = vi.hoisted(() => ({ listRepoWorktreesMock: vi.fn() }))

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

const {
  __resetDetectedWorktreeScanCacheForTests,
  invalidateDetectedWorktreeScanCache,
  listDetectedGitWorktrees
} = await import('./detected-worktree-scan-cache')

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scan reads only id, path and connectionId off the repo row.
const repo = { id: 'repo-1', path: '/repos/one', displayName: 'one' } as Repo
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scan calls only the expectation capture; the metadata prune it feeds is mocked above.
const store = {
  captureNativeLocalWorktreeMetadataScanExpectation: () => ({ repo: { id: repo.id }, metadata: [] })
} as never

function worktreeAt(path: string): GitWorktreeInfo {
  return { path, head: 'abc', branch: 'main', isBare: false, isMainWorktree: path === repo.path }
}

/** A scan whose settlement the test controls, so a mutation can land while it is in flight. */
function deferredScan(): { promise: Promise<GitWorktreeInfo[]>; settle: () => void } {
  let settle!: () => void
  const promise = new Promise<GitWorktreeInfo[]>((resolve) => {
    settle = () => resolve([worktreeAt(repo.path)])
  })
  return { promise, settle }
}

// Why this suite exists: a worktree created while a listing ran is absent from that listing, and the
// renderer reads an authoritative absence as a deletion. The scan must carry the fact that a mutation
// overtook it, for the runner AND for every caller that joined it.
describe('detected worktree scan supersession', () => {
  beforeEach(() => {
    listRepoWorktreesMock.mockReset()
    __resetDetectedWorktreeScanCacheForTests()
  })

  it('reports a scan that settled without any mutation as not superseded', async () => {
    listRepoWorktreesMock.mockResolvedValue([worktreeAt(repo.path)])
    const scan = await listDetectedGitWorktrees(store, repo)
    expect(scan.superseded).toBe(false)
    expect(scan.fresh).toBe(true)
  })

  it('reports a scan a worktree mutation overtook as superseded, for the runner and a joiner', async () => {
    const inFlight = deferredScan()
    listRepoWorktreesMock.mockReturnValueOnce(inFlight.promise)
    const runner = listDetectedGitWorktrees(store, repo)
    const joiner = listDetectedGitWorktrees(store, repo)
    expect(listRepoWorktreesMock).toHaveBeenCalledTimes(1)

    // A create finished while the scan was running.
    invalidateDetectedWorktreeScanCache(repo.id)
    inFlight.settle()

    expect((await runner).superseded).toBe(true)
    expect((await joiner).superseded).toBe(true)
  })

  it('does not cache a superseded scan, so the next listing scans again', async () => {
    const inFlight = deferredScan()
    listRepoWorktreesMock.mockReturnValueOnce(inFlight.promise)
    const runner = listDetectedGitWorktrees(store, repo)
    invalidateDetectedWorktreeScanCache(repo.id)
    inFlight.settle()
    await runner

    listRepoWorktreesMock.mockResolvedValueOnce([worktreeAt(repo.path), worktreeAt('/repos/new')])
    const next = await listDetectedGitWorktrees(store, repo)
    expect(listRepoWorktreesMock).toHaveBeenCalledTimes(2)
    expect(next.superseded).toBe(false)
    expect(next.gitWorktrees).toHaveLength(2)
  })
})
