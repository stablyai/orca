import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type * as RepoWorktrees from '../repo-worktrees'
import { listRepoWorktrees } from '../repo-worktrees'
import type { GitWorktreeInfo, Repo } from '../../shared/types'
import {
  invalidateAuthorizedRootsCache,
  rebuildAuthorizedRootsCache,
  resolveRegisteredWorktreePath
} from './filesystem-auth'

vi.mock('../repo-worktrees', async () => {
  const actual = await vi.importActual<typeof RepoWorktrees>('../repo-worktrees')
  return {
    ...actual,
    listRepoWorktrees: vi.fn()
  }
})

const LARGE_WORKTREE_ROOT_COUNT = 150_000

const repo: Repo = {
  id: 'repo-1',
  path: '/repos/app',
  displayName: 'app',
  badgeColor: '#000000',
  addedAt: 1,
  kind: 'git'
}

function makeStore(): Store {
  return {
    getRepos: () => [repo],
    getSettings: () => ({})
  } as unknown as Store
}

describe('filesystem auth worktree roots', () => {
  beforeEach(() => {
    invalidateAuthorizedRootsCache()
    vi.mocked(listRepoWorktrees).mockReset()
  })

  it('rebuilds the authorized roots cache for large worktree lists', async () => {
    const worktrees: GitWorktreeInfo[] = Array.from(
      { length: LARGE_WORKTREE_ROOT_COUNT },
      (_, index) => ({
        path: `/linked/worktree-${index}`,
        head: '',
        branch: `refs/heads/generated-${index}`,
        isBare: false,
        isMainWorktree: false
      })
    )
    vi.mocked(listRepoWorktrees).mockResolvedValue(worktrees)
    const store = makeStore()

    await rebuildAuthorizedRootsCache(store)

    const lastWorktreePath = `/linked/worktree-${LARGE_WORKTREE_ROOT_COUNT - 1}`
    await expect(resolveRegisteredWorktreePath(lastWorktreePath, store)).resolves.toBe(
      resolve(lastWorktreePath)
    )
    expect(listRepoWorktrees).toHaveBeenCalledTimes(1)
  })
})
