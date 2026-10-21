import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/repo-types'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'

const mocks = vi.hoisted(() => ({ graph: vi.fn(), runtimes: vi.fn(), realpath: vi.fn() }))
vi.mock('node:fs', () => ({ realpathSync: (path: string) => path }))
vi.mock('node:fs/promises', () => ({ stat: vi.fn(async () => ({})), realpath: mocks.realpath }))
vi.mock('../repo-worktrees', () => ({
  listRepoWorktreeGraph: mocks.graph,
  isRepoRoot: vi.fn(() => false)
}))
vi.mock('../local-project-runtime-resolution', () => ({
  resolveLocalProjectRuntimesForRepos: mocks.runtimes
}))
import { PATH_ACCESS_DENIED_MESSAGE, resolveAuthorizedPath } from './filesystem-auth'
import {
  __resetCreatedWorktreeRootsForTests,
  invalidateAuthorizedRootsCache,
  registerWorktreeRootsForRepo,
  resolveRegisteredWorktreePath
} from './registered-worktree-roots-cache'

const DISTRO = 'Ubuntu-24.04'
const repo: Repo = {
  id: 'wsl-drive-repo',
  path: resolve('/wsl-drive/repo'),
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}
// The same checkout as each Git names it: WSL Git's `/mnt/c/...` translated to the drive spelling
// every other consumer sends, and host Git reading that `/mnt/c` metadata as a different path.
const worktree = resolve('/wsl-drive/workspaces/feature-extra')
const hostGitSpelling = resolve('/mnt/c/wsl-drive/workspaces/feature-extra')
const hostRepo: Repo = { ...repo, id: 'host-repo', path: resolve('/host-drive/repo') }
const hostRepoWorktree = resolve('/host-drive/workspaces/feature')

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
const hostRuntime: ProjectExecutionRuntimeResolution = {
  status: 'resolved',
  runtime: {
    kind: 'windows-host',
    hostPlatform: 'win32',
    projectId: 'project',
    reason: 'project-override',
    cacheKey: 'project:windows-host'
  }
}
const repairRuntime: ProjectExecutionRuntimeResolution = {
  status: 'repair-required',
  repair: {
    projectId: 'project',
    preferredRuntime: { kind: 'wsl', distro: DISTRO },
    reason: 'wsl-distro-missing',
    source: 'project-override',
    cacheKey: `project:repair:wsl-distro-missing:${DISTRO}`
  }
}

function fixture(repos: Repo[] = [repo]): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization reads only these store methods; listing and runtime resolution are mocked.
  return {
    getRepos: () => repos,
    getProjectGroups: () => [],
    getFolderWorkspaces: () => [],
    getSettings: () => ({})
  } as unknown as Store
}

function useRuntime(runtime: ProjectExecutionRuntimeResolution): void {
  mocks.runtimes.mockImplementation(
    (_store: Store, repos: readonly Repo[]) =>
      new Map(repos.map((entry) => [entry.id, entry.id === hostRepo.id ? hostRuntime : runtime]))
  )
}

beforeEach(() => {
  invalidateAuthorizedRootsCache()
  __resetCreatedWorktreeRootsForTests()
  vi.resetAllMocks()
  mocks.realpath.mockImplementation(async (path: string) => path)
  mocks.graph.mockImplementation(async (listed: Repo, options?: { wslDistro?: string }) => [
    {
      path:
        listed.id === hostRepo.id
          ? hostRepoWorktree
          : options?.wslDistro === DISTRO
            ? worktree
            : hostGitSpelling
    }
  ])
  useRuntime(wslRuntime)
})

describe('authorized worktree roots for a drive repo whose project runtime is WSL', () => {
  it('lists through the project distro, so the path delete and git status send is authorized', async () => {
    await expect(resolveAuthorizedPath(worktree, fixture())).resolves.toBe(worktree)
    await expect(resolveRegisteredWorktreePath(worktree, fixture())).resolves.toBe(worktree)
    expect(mocks.graph).toHaveBeenCalledWith(repo, { wslDistro: DISTRO })
  })

  it('still refuses a path outside every root, including the spelling only host Git lists', async () => {
    const store = fixture()
    await expect(
      resolveAuthorizedPath(resolve('/wsl-drive/elsewhere/secret'), store)
    ).rejects.toThrow(PATH_ACCESS_DENIED_MESSAGE)
    await expect(resolveAuthorizedPath(join(hostGitSpelling, 'file'), store)).rejects.toThrow(
      PATH_ACCESS_DENIED_MESSAGE
    )
  })

  it('re-lists through the new Git when the project runtime changes after a listing', async () => {
    useRuntime(hostRuntime)
    const store = fixture()
    await expect(resolveAuthorizedPath(join(hostGitSpelling, 'file'), store)).resolves.toBe(
      join(hostGitSpelling, 'file')
    )

    useRuntime(wslRuntime)
    await expect(resolveAuthorizedPath(join(worktree, 'file'), store)).resolves.toBe(
      join(worktree, 'file')
    )
    expect(mocks.graph).toHaveBeenLastCalledWith(repo, { wslDistro: DISTRO })
    // The host-Git listing is retired with its owner, not kept beside the new one.
    await expect(resolveAuthorizedPath(join(hostGitSpelling, 'file'), store)).rejects.toThrow(
      PATH_ACCESS_DENIED_MESSAGE
    )
  })

  it('keeps a registration WSL Git produced without re-listing', async () => {
    const store = fixture()
    registerWorktreeRootsForRepo(store, repo.id, [repo.path, worktree], { wslDistro: DISTRO })
    await expect(resolveAuthorizedPath(resolve('/wsl-drive/outside'), store)).rejects.toThrow(
      PATH_ACCESS_DENIED_MESSAGE
    )
    expect(mocks.graph).not.toHaveBeenCalled()
    await expect(resolveAuthorizedPath(join(worktree, 'file'), store)).resolves.toBe(
      join(worktree, 'file')
    )
  })

  it('re-lists a registration host Git produced for a WSL project on the next miss', async () => {
    const store = fixture()
    registerWorktreeRootsForRepo(store, repo.id, [repo.path, hostGitSpelling])
    await expect(resolveAuthorizedPath(join(worktree, 'file'), store)).resolves.toBe(
      join(worktree, 'file')
    )
    expect(mocks.graph).toHaveBeenCalledWith(repo, { wslDistro: DISTRO })
  })

  it('lists with host Git while the runtime awaits repair, as before routing', async () => {
    useRuntime(repairRuntime)
    await expect(resolveAuthorizedPath(join(hostGitSpelling, 'file'), fixture())).resolves.toBe(
      join(hostGitSpelling, 'file')
    )
    expect(mocks.graph).toHaveBeenCalledWith(repo, {})
  })

  it('keeps the WSL listing when a resolved runtime starts awaiting repair', async () => {
    const store = fixture()
    await expect(resolveAuthorizedPath(join(worktree, 'file'), store)).resolves.toBe(
      join(worktree, 'file')
    )

    useRuntime(repairRuntime)
    await expect(resolveAuthorizedPath(resolve('/wsl-drive/outside'), store)).rejects.toThrow(
      PATH_ACCESS_DENIED_MESSAGE
    )
    expect(mocks.graph).toHaveBeenCalledTimes(1)
    await expect(resolveAuthorizedPath(join(worktree, 'file'), store)).resolves.toBe(
      join(worktree, 'file')
    )
  })

  it('re-lists in the same request when the runtime changes during an in-flight rebuild', async () => {
    useRuntime(hostRuntime)
    const store = fixture()
    let releaseHostListing = (): void => {}
    mocks.graph.mockImplementationOnce(
      (_repo: Repo) =>
        new Promise((resolveListing) => {
          releaseHostListing = () => resolveListing([{ path: hostGitSpelling }])
        })
    )
    const earlier = resolveAuthorizedPath(resolve('/wsl-drive/outside'), store)
    await vi.waitFor(() => expect(mocks.graph).toHaveBeenCalledTimes(1))

    useRuntime(wslRuntime)
    const afterSwitch = resolveAuthorizedPath(join(worktree, 'file'), store)
    releaseHostListing()
    await expect(earlier).rejects.toThrow(PATH_ACCESS_DENIED_MESSAGE)
    await expect(afterSwitch).resolves.toBe(join(worktree, 'file'))
  })

  it('keeps a host-runtime repo in the same cache on host Git', async () => {
    const store = fixture([repo, hostRepo])
    await expect(resolveAuthorizedPath(join(hostRepoWorktree, 'file'), store)).resolves.toBe(
      join(hostRepoWorktree, 'file')
    )
    await expect(resolveAuthorizedPath(join(worktree, 'file'), store)).resolves.toBe(
      join(worktree, 'file')
    )
    expect(mocks.graph).toHaveBeenCalledWith(hostRepo, {})
    expect(mocks.graph).toHaveBeenCalledWith(repo, { wslDistro: DISTRO })
    expect(mocks.graph).toHaveBeenCalledTimes(2)
  })
})
