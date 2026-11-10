import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../../../persistence/loading-store/store'
import type { Repo } from '../../../../shared/repo-types'

const mocks = vi.hoisted(() => ({ graph: vi.fn(), stat: vi.fn(), realpath: vi.fn() }))
vi.mock('node:fs', () => ({ realpathSync: (path: string) => path, statSync: mocks.stat }))
vi.mock('node:fs/promises', () => ({ stat: mocks.stat, realpath: mocks.realpath }))
vi.mock('../../../workspaces/catalog/repo-worktrees', () => ({
  listRepoWorktreeGraph: mocks.graph,
  isRepoRoot: vi.fn(() => false)
}))
vi.mock('../../worktree-logic', () => ({
  computeWorkspaceRoot: vi.fn(),
  getWorktreePathSettings: vi.fn()
}))
vi.mock('../../../workspaces/execution-host/project-runtime-git-options', () => ({
  getWorktreeMirrorDistroForRuntime: vi.fn()
}))
import { resolveAuthorizedPath } from '../../filesystem/access/filesystem-auth'
import {
  __resetCreatedWorktreeRootsForTests,
  invalidateAuthorizedRootsCache,
  registerCreatedWorktreeRoot,
  registerWorktreeRootsForRepo
} from './registered-worktree-roots-cache'

const root = resolve('/registry-review-repo')
const linked = resolve('/registry-review-linked')
const canonical = resolve('/registry-review-canonical')
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
async function deferredAlias(store: Store) {
  const normalization = deferred<string>()
  mocks.realpath.mockImplementation((path: string) => {
    if (path === linked) {
      return normalization.promise
    }
    if (path === join(linked, 'file')) {
      return Promise.resolve(join(canonical, 'file'))
    }
    return Promise.resolve(path)
  })
  const authorization = resolveAuthorizedPath(join(linked, 'file'), store)
  await vi.waitFor(() => expect(mocks.realpath).toHaveBeenCalledWith(linked))
  return { authorization, normalization }
}
async function expectDenied(path: string, store: Store) {
  await expect(resolveAuthorizedPath(path, store)).rejects.toThrow('Access denied')
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

describe('canonical alias publication respects current registration', () => {
  it('does not let an obsolete alias outlive a replacement listing', async () => {
    const store = fixture([local])
    registerWorktreeRootsForRepo(store, local.id, [linked])
    const { authorization, normalization } = await deferredAlias(store)
    registerWorktreeRootsForRepo(store, local.id, [replacement])
    normalization.resolve(canonical)
    await expect(authorization).rejects.toThrow('Access denied')
    await expectDenied(join(canonical, 'later'), store)
    await expect(resolveAuthorizedPath(join(replacement, 'file'), store)).resolves.toBe(
      join(replacement, 'file')
    )
  })
})

describe('qualified registration', () => {
  it('preserves own-store runtime roots but retires a changed runtime identity', async () => {
    const runtime: Repo = { ...local, executionHostId: 'runtime:a' }
    const repos = [runtime]
    const store = fixture(repos)
    registerCreatedWorktreeRoot(store, runtime, linked)
    await expect(resolveAuthorizedPath(join(linked, 'file'), store)).resolves.toBe(
      join(linked, 'file')
    )
    repos[0] = { ...runtime, executionHostId: 'runtime:b' }
    await expectDenied(join(linked, 'file'), store)
  })
})
