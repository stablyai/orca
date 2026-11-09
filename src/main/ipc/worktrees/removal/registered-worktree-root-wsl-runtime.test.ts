import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../../../persistence/loading-store/store'
import type { Repo } from '../../../../shared/repo-types'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/execution-host/project-execution-runtime'

const mocks = vi.hoisted(() => ({ graph: vi.fn(), runtimes: vi.fn(), realpath: vi.fn() }))
vi.mock('node:fs', () => ({ realpathSync: (path: string) => path }))
vi.mock('node:fs/promises', () => ({ stat: vi.fn(async () => ({})), realpath: mocks.realpath }))
vi.mock('../../../workspaces/catalog/repo-worktrees', () => ({
  listRepoWorktreeGraph: mocks.graph,
  isRepoRoot: vi.fn(() => false)
}))
vi.mock('../../../workspaces/execution-host/local-project-runtime-resolution', () => ({
  resolveLocalProjectRuntimesForRepos: mocks.runtimes
}))
import { resolveAuthorizedPath } from '../../filesystem/access/filesystem-auth'
import {
  __resetCreatedWorktreeRootsForTests,
  invalidateAuthorizedRootsCache,
  registerWorktreeRootsForRepo
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
  it('re-lists a registration host Git produced for a WSL project on the next miss', async () => {
    const store = fixture()
    registerWorktreeRootsForRepo(store, repo.id, [repo.path, hostGitSpelling])
    await expect(resolveAuthorizedPath(join(worktree, 'file'), store)).resolves.toBe(
      join(worktree, 'file')
    )
    expect(mocks.graph).toHaveBeenCalledWith(repo, { wslDistro: DISTRO })
  })
})
