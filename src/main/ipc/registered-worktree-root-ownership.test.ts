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
  it.each(['canonical', 'legacy'] as const)(
    'retires an in-flight alias after %s SSH ownership',
    async (shape) => {
      const repos = [{ ...local }]
      const store = fixture(repos)
      registerWorktreeRootsForRepo(store, local.id, [linked])
      const { authorization, normalization } = await deferredAlias(store)
      repos[0] =
        shape === 'canonical'
          ? { ...local, executionHostId: 'ssh:remote' }
          : { ...local, connectionId: 'remote' }
      invalidateAuthorizedRootsCache()
      normalization.resolve(canonical)
      await expect(authorization).rejects.toThrow('Access denied')
      await expectDenied(join(canonical, 'later'), store)
    }
  )
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
  it('does not cache an alias from an invalidated listing', async () => {
    const store = fixture([local])
    registerWorktreeRootsForRepo(store, local.id, [linked])
    const { authorization, normalization } = await deferredAlias(store)
    invalidateAuthorizedRootsCache()
    normalization.resolve(canonical)
    await expect(authorization).rejects.toThrow('Access denied')
    await expectDenied(join(canonical, 'later'), store)
  })
  it('retains a completed alias while its original owner remains local', async () => {
    const store = fixture([local])
    registerWorktreeRootsForRepo(store, local.id, [linked])
    const { authorization, normalization } = await deferredAlias(store)
    normalization.resolve(canonical)
    await expect(authorization).resolves.toBe(join(canonical, 'file'))
    await expect(resolveAuthorizedPath(join(canonical, 'later'), store)).resolves.toBe(
      join(canonical, 'later')
    )
  })
})

describe('recovered grant ownership and prune completion', () => {
  it('does not apply old ENOENT evidence to a renewed recovered grant', async () => {
    const probe = deferred<object>()
    mocks.stat.mockReturnValueOnce(probe.promise)
    const store = fixture([local])
    registerCreatedWorktreeRoot(store, local.id, linked)
    const rebuilding = rebuildAuthorizedRootsCache(store)
    await vi.waitFor(() => expect(mocks.stat).toHaveBeenCalledWith(linked))
    registerCreatedWorktreeRoot(store, local.id, linked)
    probe.reject(Object.assign(new Error('old absence'), { code: 'ENOENT' }))
    await rebuilding
    await expect(resolveAuthorizedPath(join(linked, 'file'), store)).resolves.toBe(
      join(linked, 'file')
    )
  })
  it.each([false, true])(
    'retires recovered roots after same-ID local path replacement (invalidate=%s)',
    async (invalidate) => {
      const repos = [{ ...local }]
      const store = fixture(repos)
      registerCreatedWorktreeRoot(store, local.id, linked)
      repos[0] = { ...local, path: replacement }
      if (invalidate) {
        invalidateAuthorizedRootsCache()
      }
      await expectDenied(join(linked, 'file'), store)
    }
  )
  it.each(['listed', 'created'] as const)(
    'rejects ambiguous %s registration for one ID and two local paths',
    async (kind) => {
      const store = fixture([local, { ...local, path: replacement }])
      if (kind === 'listed') {
        registerWorktreeRootsForRepo(store, local.id, [linked])
      } else {
        registerCreatedWorktreeRoot(store, local.id, linked)
      }
      await expectDenied(join(linked, 'file'), store)
    }
  )
  it('preserves a still-local recovered root across ordinary invalidation', async () => {
    const store = fixture([local])
    registerCreatedWorktreeRoot(store, local.id, linked)
    invalidateAuthorizedRootsCache()
    await expect(resolveAuthorizedPath(join(linked, 'file'), store)).resolves.toBe(
      join(linked, 'file')
    )
  })
  it('preserves a recovered root when its filesystem probe returns EIO', async () => {
    const store = fixture([local])
    registerCreatedWorktreeRoot(store, local.id, linked)
    mocks.stat.mockRejectedValue(Object.assign(new Error('unavailable'), { code: 'EIO' }))
    await rebuildAuthorizedRootsCache(store)
    await expect(resolveAuthorizedPath(join(linked, 'file'), store)).resolves.toBe(
      join(linked, 'file')
    )
  })
  it('preserves a recovered root on timeout and after late ENOENT', async () => {
    vi.useFakeTimers()
    const probe = deferred<object>()
    mocks.stat.mockReturnValueOnce(probe.promise)
    const store = fixture([local])
    registerCreatedWorktreeRoot(store, local.id, linked)
    const rebuilding = rebuildAuthorizedRootsCache(store)
    await vi.advanceTimersByTimeAsync(1_001)
    await rebuilding
    probe.reject(Object.assign(new Error('late absence'), { code: 'ENOENT' }))
    await Promise.resolve()
    await expect(resolveAuthorizedPath(join(linked, 'file'), store)).resolves.toBe(
      join(linked, 'file')
    )
  })
  it('keeps the newer registration when an older graph listing completes', async () => {
    const graph = deferred<{ path: string }[]>()
    mocks.graph.mockReturnValueOnce(graph.promise)
    const store = fixture([local])
    const rebuilding = rebuildAuthorizedRootsCache(store)
    expect(mocks.graph).toHaveBeenCalledOnce()
    registerWorktreeRootsForRepo(store, local.id, [replacement])
    graph.resolve([{ path: linked }])
    await rebuilding
    await expectDenied(join(linked, 'file'), store)
    await expect(resolveAuthorizedPath(join(replacement, 'file'), store)).resolves.toBe(
      join(replacement, 'file')
    )
  })
})

describe('qualified registration', () => {
  it.each(['listed', 'created'] as const)(
    'keeps legitimate %s roots with overlapping local and SSH IDs',
    async (kind) => {
      const remote: Repo = { ...local, executionHostId: 'ssh:remote' }
      const store = fixture([local, remote])
      if (kind === 'listed') {
        registerWorktreeRootsForRepo(store, local, [linked])
        registerWorktreeRootsForRepo(store, remote, [replacement])
      } else {
        registerCreatedWorktreeRoot(store, local, linked)
        registerCreatedWorktreeRoot(store, remote, replacement)
      }
      await expect(resolveAuthorizedPath(join(linked, 'file'), store)).resolves.toBe(
        join(linked, 'file')
      )
      await expectDenied(join(replacement, 'file'), store)
    }
  )
  it('preserves a root still owned by another qualified local repository', async () => {
    const second = { ...local, path: replacement }
    const repos = [local, second]
    const store = fixture(repos)
    registerCreatedWorktreeRoot(store, local, linked)
    registerCreatedWorktreeRoot(store, second, linked)
    repos[0] = { ...local, executionHostId: 'ssh:remote' }
    invalidateAuthorizedRootsCache()
    await expect(resolveAuthorizedPath(join(linked, 'file'), store)).resolves.toBe(
      join(linked, 'file')
    )
  })
  it('keeps recovered roots across harmless display metadata changes', async () => {
    const repos = [{ ...local }]
    const store = fixture(repos)
    registerCreatedWorktreeRoot(store, local, linked)
    repos[0] = { ...local, displayName: 'Renamed' }
    invalidateAuthorizedRootsCache()
    await expect(resolveAuthorizedPath(join(linked, 'file'), store)).resolves.toBe(
      join(linked, 'file')
    )
    expect(mocks.graph).not.toHaveBeenCalled()
    expect(mocks.stat).not.toHaveBeenCalled()
  })
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
  it.each(['canonical', 'legacy'] as const)(
    'discards obsolete %s SSH graph results',
    async (shape) => {
      const graph = deferred<{ path: string }[]>()
      mocks.graph.mockReturnValueOnce(graph.promise)
      const repos = [{ ...local }]
      const store = fixture(repos)
      const rebuilding = rebuildAuthorizedRootsCache(store)
      repos[0] =
        shape === 'canonical'
          ? { ...local, executionHostId: 'ssh:remote' }
          : { ...local, connectionId: 'remote' }
      invalidateAuthorizedRootsCache()
      graph.resolve([{ path: linked }])
      await rebuilding
      await expectDenied(join(linked, 'file'), store)
      expect(mocks.graph).toHaveBeenCalledOnce()
      expect(mocks.stat).not.toHaveBeenCalled()
    }
  )
})
