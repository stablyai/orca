import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { resolveAuthorizedPath } from './filesystem-auth'
import {
  __resetCreatedWorktreeRootsForTests,
  invalidateAuthorizedRootsCache,
  rebuildAuthorizedRootsCache,
  registerWorktreeRootsForRepo
} from './registered-worktree-roots-cache'

const root = resolve('/registry-review-repo')
const linked = resolve('/registry-review-linked')
const replacement = resolve('/registry-review-replacement')
const local: Repo = { id: 'owner', path: root, displayName: 'repo', badgeColor: '#000', addedAt: 0 }
function fixture(repos: Repo[]): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The actual authorization APIs only read these four store methods; filesystem and graph boundaries are mocked.
  return {
    getRepos: () => repos,
    getProjectGroups: () => [],
    getFolderWorkspaces: () => [],
    getSettings: () => ({})
  } as unknown as Store
}
function deferred<T>() {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (error: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}
beforeEach(() => {
  invalidateAuthorizedRootsCache()
  __resetCreatedWorktreeRootsForTests()
  vi.resetAllMocks()
  mocks.graph.mockResolvedValue([])
  mocks.stat.mockResolvedValue({})
  mocks.realpath.mockImplementation(async (path: string) => path)
})
afterEach(() => vi.useRealTimers())

describe('current request follows a superseded rebuild', () => {
  it('rebuilds the current local catalog before deciding a request that joined obsolete work', async () => {
    const graph = deferred<{ path: string }[]>()
    mocks.graph.mockReturnValueOnce(graph.promise)
    const repos = [{ ...local }]
    const store = fixture(repos)
    const first = resolveAuthorizedPath(join(linked, 'file'), store)
    const firstResult = first.then(
      (value) => ({ value }),
      (error) => ({ error })
    )
    await vi.waitFor(() => expect(mocks.graph).toHaveBeenCalledOnce())
    repos[0] = { ...local, path: replacement }
    invalidateAuthorizedRootsCache()
    mocks.graph.mockResolvedValue([{ path: linked }])
    const current = resolveAuthorizedPath(join(linked, 'file'), store)
    const currentResult = current.then(
      (value) => ({ value }),
      (error) => ({ error })
    )
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    graph.resolve([])
    const [, result] = await Promise.all([firstResult, currentResult])
    expect(result).toEqual({ value: join(linked, 'file') })
    expect(mocks.graph).toHaveBeenCalledTimes(2)
  })
})

it.each([1, 64, 256])('records catalog work for %s cold-rebuild repositories', async (count) => {
  let pathReads = 0
  const repos: Repo[] = Array.from({ length: count }, (_, i) => ({
    id: `repo-${i}`,
    get path() {
      pathReads++
      return resolve(`/review-repo-${i}`)
    },
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0
  }))
  const store = fixture(repos)
  const getRepos = vi.spyOn(store, 'getRepos')
  await rebuildAuthorizedRootsCache(store)
  expect(mocks.graph).toHaveBeenCalledTimes(count)
  expect(getRepos.mock.calls.length).toBeLessThanOrEqual(3)
  expect(pathReads).toBeLessThanOrEqual(4 * count)
})
it('records catalog work for one warm linked-file authorization', async () => {
  const repo: Repo = {
    id: 'repo',
    path: resolve('/review-repo'),
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0
  }
  const store = fixture([repo])
  const getRepos = vi.spyOn(store, 'getRepos')
  const linked = resolve('/review-linked')
  registerWorktreeRootsForRepo(store, repo.id, [linked])
  getRepos.mockClear()
  await expect(resolveAuthorizedPath(resolve(linked, 'file'), store)).resolves.toBe(
    resolve(linked, 'file')
  )
  expect(mocks.graph).not.toHaveBeenCalled()
  expect(getRepos.mock.calls.length).toBeLessThanOrEqual(3)
})
