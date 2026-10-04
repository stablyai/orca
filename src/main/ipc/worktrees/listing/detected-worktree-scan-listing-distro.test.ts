import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Store } from '../../../persistence/loading-store/store'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  gitOptions: vi.fn(),
  registerRoots: vi.fn()
}))

vi.mock('../../../repo-worktrees', () => ({ listRepoWorktreesForDetectedScan: mocks.list }))
vi.mock('../../../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: mocks.gitOptions
}))
vi.mock('../../registered-worktree-roots-cache', () => ({
  getRegisteredWorktreeRootsRevision: () => 1,
  registerWorktreeRootsForRepo: mocks.registerRoots
}))
vi.mock('../../../worktree-lineage-pruning', () => ({
  pruneLineageForMissingRepoWorktrees: vi.fn()
}))

const {
  __resetDetectedWorktreeScanCacheForTests,
  applyFreshDetectedWorktreeScanSideEffects,
  listDetectedGitWorktrees
} = await import('./detected-worktree-scan-cache')

const repo: Repo = {
  id: 'repo-1',
  path: '/repos/one',
  displayName: 'one',
  badgeColor: '#000',
  addedAt: 0
}
const worktree = { path: '/repos/one-feature', head: 'abc', branch: 'feature', isBare: false }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a first local scan reads only this store method; routing, listing and registration are mocked.
const store = { captureNativeLocalWorktreeMetadataScanExpectation: vi.fn() } as unknown as Store

async function scanAndRegister(): Promise<void> {
  const scan = await listDetectedGitWorktrees(store, repo)
  await applyFreshDetectedWorktreeScanSideEffects(store, repo, scan.gitWorktrees, undefined, {
    sideEffectToken: scan.sideEffectToken,
    hygieneDue: false
  })
}

describe('detected worktree scan root registration', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.list.mockResolvedValue([{ ...worktree, isMainWorktree: false }])
    __resetDetectedWorktreeScanCacheForTests()
  })

  it('records the distro whose Git listed the scan', async () => {
    mocks.gitOptions.mockReturnValue({ wslDistro: 'Ubuntu-24.04' })
    await scanAndRegister()

    expect(mocks.registerRoots).toHaveBeenCalledWith(
      store,
      repo,
      [repo.path, worktree.path],
      expect.objectContaining({ wslDistro: 'Ubuntu-24.04' })
    )
  })

  it('records host Git for a scan listed without a distro', async () => {
    mocks.gitOptions.mockReturnValue({})
    await scanAndRegister()

    expect(mocks.registerRoots).toHaveBeenCalledTimes(1)
    expect(mocks.registerRoots.mock.calls[0]?.[3]?.wslDistro).toBeUndefined()
  })
})
