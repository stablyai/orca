import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type * as RepoWorktrees from '../repo-worktrees'
import { listRepoWorktrees } from '../repo-worktrees'
import type { Repo } from '../../shared/repo-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import {
  ensureAuthorizedRootsCache,
  invalidateAuthorizedRootsCache,
  isRegisteredWorktreePath,
  resolveRegisteredWorktreePath
} from './registered-worktree-roots-cache'

vi.mock('../repo-worktrees', async () => {
  const actual = await vi.importActual<typeof RepoWorktrees>('../repo-worktrees')
  return {
    ...actual,
    listRepoWorktrees: vi.fn()
  }
})

const repo: Repo = {
  id: 'repo-1',
  path: '/repos/app',
  displayName: 'app',
  badgeColor: '#000000',
  addedAt: 1,
  kind: 'git'
}

function makeStore(repos: Repo[]): Store {
  return { getRepos: () => repos } as unknown as Store
}

function linkedWorktree(path: string): GitWorktreeInfo {
  return { path, head: '', branch: 'refs/heads/feature', isBare: false, isMainWorktree: false }
}

// Parks the first `git worktree list` so a mutation can land mid-rebuild.
function parkFirstWorktreeListing(): (worktrees: GitWorktreeInfo[]) => void {
  let release!: (worktrees: GitWorktreeInfo[]) => void
  vi.mocked(listRepoWorktrees).mockReturnValueOnce(
    new Promise((resolvePromise) => {
      release = resolvePromise
    })
  )
  return release
}

describe('authorized roots cache invalidation during a rebuild', () => {
  beforeEach(() => {
    invalidateAuthorizedRootsCache()
    vi.mocked(listRepoWorktrees).mockReset()
  })

  it('still authorizes a worktree created while a rebuild was awaiting git', async () => {
    const release = parkFirstWorktreeListing()
    // What git reports once the new worktree exists.
    vi.mocked(listRepoWorktrees).mockResolvedValue([linkedWorktree('/linked/new')])
    const store = makeStore([repo])

    const pending = ensureAuthorizedRootsCache(store)
    // The worktree is created while the first listing is still in flight.
    invalidateAuthorizedRootsCache()
    release([])
    await pending

    await expect(resolveRegisteredWorktreePath('/linked/new', store)).resolves.toBe(
      resolve('/linked/new')
    )
  })

  it('does not resurrect roots of a repo forgotten while a rebuild was awaiting git', async () => {
    const release = parkFirstWorktreeListing()
    vi.mocked(listRepoWorktrees).mockResolvedValue([])
    const repos = [repo]
    const store = makeStore(repos)

    const pending = ensureAuthorizedRootsCache(store)
    // The repo is forgotten while the first listing is still in flight.
    repos.length = 0
    invalidateAuthorizedRootsCache()
    release([linkedWorktree('/linked/old')])
    await pending
    await ensureAuthorizedRootsCache(store)

    expect(isRegisteredWorktreePath('/repos/app')).toBe(false)
    expect(isRegisteredWorktreePath('/linked/old')).toBe(false)
  })
})
