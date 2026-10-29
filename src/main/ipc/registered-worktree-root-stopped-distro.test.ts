import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/repo-types'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'

const mocks = vi.hoisted(() => ({
  graph: vi.fn(),
  runtimes: vi.fn(),
  realpath: vi.fn(),
  running: vi.fn(async () => true)
}))
vi.mock('../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readWslDistroRunningState: async () => ((await mocks.running()) ? 'running' : 'stopped')
}))
vi.mock('node:fs', () => ({ realpathSync: (path: string) => path }))
vi.mock('node:fs/promises', () => ({ stat: vi.fn(async () => ({})), realpath: mocks.realpath }))
vi.mock('../repo-worktrees', () => ({
  listRepoWorktreeGraph: mocks.graph,
  isRepoRoot: vi.fn(() => false)
}))
vi.mock('../local-project-runtime-resolution', () => ({
  resolveLocalProjectRuntimesForRepos: mocks.runtimes
}))
import { resolveAuthorizedPath } from './filesystem/filesystem-auth'
import { runAsWslUserAct } from '../wsl/wsl-unc-access-gate'
import {
  __resetCreatedWorktreeRootsForTests,
  invalidateAuthorizedRootsCache,
  markAuthorizedRootsOwnerDirty
} from './registered-worktree-roots-cache'

const DISTRO = 'Ubuntu-24.04'
const repo: Repo = {
  id: 'wsl-drive-repo',
  path: resolve('/wsl-drive/repo'),
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}
// WSL and host Git name this checkout differently when reading the same /mnt/c metadata.
const worktree = resolve('/wsl-drive/workspaces/feature-extra')

const wslRuntime: ProjectExecutionRuntimeResolution = {
  status: 'resolved',
  runtime: {
    kind: 'wsl',
    hostPlatform: 'wsl',
    distro: DISTRO,
    projectId: 'project',
    reason: 'project-override',
    cacheKey: `project:wsl:${DISTRO}`
  }
}
function fixture(): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization reads only these store methods; listing and runtime resolution are mocked.
  return {
    getRepos: () => [repo],
    getProjectGroups: () => [],
    getFolderWorkspaces: () => [],
    getSettings: () => ({})
  } as unknown as Store
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

beforeEach(() => {
  invalidateAuthorizedRootsCache()
  __resetCreatedWorktreeRootsForTests()
  vi.resetAllMocks()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  mocks.realpath.mockImplementation(async (path: string) => path)
  mocks.graph.mockResolvedValue([{ path: worktree }])
  mocks.running.mockResolvedValue(true)
  mocks.runtimes.mockImplementation(
    (_store: Store, repos: readonly Repo[]) => new Map(repos.map((entry) => [entry.id, wslRuntime]))
  )
})

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
})

// Any authorization miss rebuilds the roots; listing a stopped distro's repo would boot it (E9).
describe('authorized roots for a repo whose WSL distro is stopped', () => {
  it('skips the listing and leaves the repo to be listed later', async () => {
    const store = fixture()
    await expect(resolveAuthorizedPath(join(worktree, 'file'), store)).resolves.toBe(
      join(worktree, 'file')
    )
    expect(mocks.graph).toHaveBeenCalledOnce()

    mocks.running.mockResolvedValue(false)
    markAuthorizedRootsOwnerDirty(store, repo)
    // The repo root itself stays authorized; its worktrees wait for a listing, which would boot it.
    await expect(resolveAuthorizedPath(join(repo.path, 'file'), store)).resolves.toBe(
      join(repo.path, 'file')
    )
    await expect(resolveAuthorizedPath(join(worktree, 'file'), store)).rejects.toThrow()
    expect(mocks.graph).toHaveBeenCalledOnce()
  })

  it('lists the repo once its distro runs again', async () => {
    const store = fixture()
    mocks.running.mockResolvedValue(false)
    await resolveAuthorizedPath(join(worktree, 'file'), store).catch(() => undefined)
    expect(mocks.graph).not.toHaveBeenCalled()

    mocks.running.mockResolvedValue(true)
    await expect(resolveAuthorizedPath(join(worktree, 'file'), store)).resolves.toBe(
      join(worktree, 'file')
    )
    expect(mocks.graph).toHaveBeenCalledWith(repo, { wslDistro: DISTRO })
  })

  it("lists an external worktree's repo when a user act on its distro misses authorization", async () => {
    const store = fixture()
    mocks.running.mockResolvedValue(false)
    // After a relaunch the external worktree is only authorized through the listing.
    await expect(
      runAsWslUserAct(DISTRO, () => resolveAuthorizedPath(join(worktree, 'file'), store))
    ).resolves.toBe(join(worktree, 'file'))
    expect(mocks.graph).toHaveBeenCalledWith(repo, { wslDistro: DISTRO })
  })
})
