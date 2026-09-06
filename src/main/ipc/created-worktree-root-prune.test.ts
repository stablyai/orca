import type * as NodeFsPromises from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RepoWorktrees from '../repo-worktrees'
import { listRepoWorktreeGraph } from '../repo-worktrees'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/repo-types'
import {
  __resetCreatedWorktreeRootsForTests,
  invalidateAuthorizedRootsCache,
  rebuildAuthorizedRootsCache,
  registerCreatedWorktreeRoot,
  resolveRegisteredWorktreePath
} from './registered-worktree-roots-cache'

const { statMock } = vi.hoisted(() => ({ statMock: vi.fn() }))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
  return { ...actual, stat: statMock }
})

vi.mock('../repo-worktrees', async () => {
  const actual = await vi.importActual<typeof RepoWorktrees>('../repo-worktrees')
  return { ...actual, listRepoWorktreeGraph: vi.fn() }
})

const repo: Repo = {
  id: 'repo-1',
  path: '/repos/app',
  displayName: 'app',
  badgeColor: '#000000',
  addedAt: 1,
  kind: 'git'
}

const RECOVERED = resolve('/linked/recovered')

function makeStore(): Store {
  return {
    getRepos: () => [repo],
    getProjectGroups: () => [],
    getFolderWorkspaces: () => [],
    getSettings: () => ({})
  } as unknown as Store
}

function statError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException
  error.code = code
  return error
}

/** A recovered root outlives a rebuild unless the rebuild proves it is listed again or gone (#16520). */
describe('recovered worktree root pruning', () => {
  beforeEach(() => {
    invalidateAuthorizedRootsCache()
    __resetCreatedWorktreeRootsForTests()
    vi.mocked(listRepoWorktreeGraph).mockReset()
    // The #16520 outage itself: `listWorktrees` softens every Git failure to `[]`, so the rebuild
    // reports success with the recovered row missing and the probe is the only remaining evidence.
    vi.mocked(listRepoWorktreeGraph).mockResolvedValue([])
    statMock.mockReset()
    statMock.mockResolvedValue({})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retires a recovered root the probe proves is gone', async () => {
    const store = makeStore()
    registerCreatedWorktreeRoot(store, repo.id, RECOVERED)
    statMock.mockRejectedValue(statError('ENOENT'))

    await rebuildAuthorizedRootsCache(store)

    await expect(resolveRegisteredWorktreePath(RECOVERED, store)).rejects.toThrow('Access denied')
  })

  it('keeps a recovered root when the probe fails for any reason but ENOENT', async () => {
    // A transient EACCES/EIO is not evidence of removal, and revoking on it would deny a worktree
    // the user is working in.
    for (const code of ['EACCES', 'EIO', 'EPERM']) {
      __resetCreatedWorktreeRootsForTests()
      const store = makeStore()
      registerCreatedWorktreeRoot(store, repo.id, RECOVERED)
      statMock.mockRejectedValue(statError(code))

      await rebuildAuthorizedRootsCache(store)

      await expect(resolveRegisteredWorktreePath(RECOVERED, store)).resolves.toBe(RECOVERED)
    }
  })

  it('finishes the rebuild and keeps the root when the probe never settles', async () => {
    // A dead mount pins the syscall; the rebuild gates filesystem auth, so it must not wait on it.
    vi.useFakeTimers()
    const store = makeStore()
    registerCreatedWorktreeRoot(store, repo.id, RECOVERED)
    statMock.mockReturnValue(new Promise(() => {}))

    const rebuild = rebuildAuthorizedRootsCache(store)
    await vi.advanceTimersByTimeAsync(5_000)
    await rebuild
    vi.useRealTimers()

    await expect(resolveRegisteredWorktreePath(RECOVERED, store)).resolves.toBe(RECOVERED)
  })

  it('refuses a recovered root at capacity instead of evicting an authorized one', async () => {
    const store = makeStore()
    const first = resolve('/linked/recovered-0')
    for (let i = 0; i < 64; i += 1) {
      registerCreatedWorktreeRoot(store, repo.id, resolve(`/linked/recovered-${i}`))
    }
    const overflow = resolve('/linked/recovered-overflow')
    registerCreatedWorktreeRoot(store, repo.id, overflow)

    await expect(resolveRegisteredWorktreePath(first, store)).resolves.toBe(first)
    await expect(resolveRegisteredWorktreePath(overflow, store)).rejects.toThrow('Access denied')
  })
})
