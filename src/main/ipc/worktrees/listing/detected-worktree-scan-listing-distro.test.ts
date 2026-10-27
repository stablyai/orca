import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Store } from '../../../persistence/loading-store/store'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  gitOptions: vi.fn(),
  registerRoots: vi.fn(),
  running: vi.fn(async () => true)
}))
vi.mock('../../../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readWslDistroRunningState: async () => ((await mocks.running()) ? 'running' : 'stopped')
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
const { WslDistroStoppedError } = await import('../../../wsl/wsl-unc-access-gate')

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

// A stopped distro fails the scan as unavailable, so rows are kept, instead of booting it (E9).
describe('detected worktree scan for a stopped WSL distro', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    vi.resetAllMocks()
    __resetDetectedWorktreeScanCacheForTests()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    mocks.gitOptions.mockReturnValue({ wslDistro: 'Ubuntu-24.04' })
    mocks.list.mockResolvedValue([])
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('does not run Git, and scans once the distro runs', async () => {
    mocks.running.mockResolvedValue(false)
    await expect(listDetectedGitWorktrees(store, repo)).rejects.toBeInstanceOf(
      WslDistroStoppedError
    )
    expect(mocks.list).not.toHaveBeenCalled()

    mocks.running.mockResolvedValue(true)
    await listDetectedGitWorktrees(store, repo)
    expect(mocks.list).toHaveBeenCalledOnce()
  })
})
