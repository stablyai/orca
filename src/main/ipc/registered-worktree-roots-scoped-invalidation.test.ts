import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/repo-types'

const mocks = vi.hoisted(() => ({ graph: vi.fn(), stat: vi.fn(), realpath: vi.fn() }))
vi.mock('node:fs', () => ({ realpathSync: (path: string) => path, statSync: mocks.stat }))
vi.mock('node:fs/promises', () => ({ stat: mocks.stat, realpath: mocks.realpath }))
vi.mock('../repo-worktrees', () => ({
  listRepoWorktreeGraph: mocks.graph,
  isRepoRoot: vi.fn(() => false)
}))
vi.mock('./worktree-logic', () => ({
  computeWorkspaceRoot: vi.fn(),
  getWorktreePathSettings: vi.fn()
}))
vi.mock('../project-runtime-git-options', () => ({
  getWorktreeMirrorDistroForRuntime: vi.fn(),
  resolveLocalProjectRuntimesForRepos: vi.fn()
}))
import {
  invalidateAuthorizedRootsCache,
  rebuildAuthorizedRootsCache
} from './registered-worktree-roots-cache'
import { invalidateAuthorizedRootsCacheForRepo } from './registered-worktree-roots-scoped-invalidation'

const REPO_COUNT = 12
const repos: Repo[] = Array.from({ length: REPO_COUNT }, (_, index) => ({
  id: `repo-${index}`,
  path: resolve(`/scoped-invalidation-${index}`),
  displayName: `repo-${index}`,
  badgeColor: '#000',
  addedAt: 0
}))

function fixture(): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the authorization cache only reads these four store methods; filesystem and graph boundaries are mocked.
  return {
    getRepos: () => repos,
    getProjectGroups: () => [],
    getFolderWorkspaces: () => [],
    getSettings: () => ({})
  } as unknown as Store
}

function listedRepoPaths(): string[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this file installs the listRepoWorktreeGraph mock, so every call's first argument is the Repo it was handed.
  return mocks.graph.mock.calls.map((call) => (call[0] as Repo).path)
}

describe('authorized-roots invalidation scope', () => {
  let store: Store

  beforeEach(async () => {
    mocks.graph.mockReset()
    mocks.graph.mockImplementation((repo: Repo) =>
      Promise.resolve([{ path: resolve(repo.path, 'wt') }])
    )
    mocks.stat.mockReset()
    mocks.stat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    store = fixture()
    // Prime every owner so a later scoped invalidation has clean state to dirty.
    invalidateAuthorizedRootsCache()
    await rebuildAuthorizedRootsCache(store)
    mocks.graph.mockClear()
  })

  /**
   * The regression this pins: the global form dirties every owner, so one worktree
   * mutation cost a `git worktree list` per registered repo — ~58 spawns and seconds
   * of git wall-clock on a real fleet, to rediscover roots only one repo changed.
   */
  it('relists only the mutated repo', async () => {
    invalidateAuthorizedRootsCacheForRepo(store, repos[3])
    await rebuildAuthorizedRootsCache(store, true)

    expect(listedRepoPaths()).toEqual([repos[3].path])
  })

  it('still relists every repo for a change of unknown scope', async () => {
    invalidateAuthorizedRootsCache()
    await rebuildAuthorizedRootsCache(store, true)

    expect(listedRepoPaths()).toHaveLength(REPO_COUNT)
  })

  it('re-lists everything for an explicit rebuild, which callers use to force a refresh', async () => {
    await rebuildAuthorizedRootsCache(store)

    expect(listedRepoPaths()).toHaveLength(REPO_COUNT)
  })

  it('falls back to a global relist when the repo has no known owner', async () => {
    // An unregistered repo must not silently skip invalidation and leave a stale
    // allowlist, so the global form is the safe fallback.
    invalidateAuthorizedRootsCacheForRepo(store, {
      ...repos[0],
      id: 'unregistered',
      path: resolve('/scoped-invalidation-unregistered')
    })
    await rebuildAuthorizedRootsCache(store, true)

    expect(listedRepoPaths()).toHaveLength(REPO_COUNT)
  })
})
