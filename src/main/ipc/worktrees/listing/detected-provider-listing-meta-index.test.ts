/**
 * The SSH worktree-meta index is only ever read via `metaIndex.get(repo.id)` on the disconnected
 * fallbacks, so a connected listing must not pay `parseWorktreeId` over the whole host snapshot.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Store } from '../../../persistence/loading-store/store'
import type * as SshWorktreeFallbackModule from './ssh-worktree-fallback'

const { getSshGitProviderMock, indexBuildSpy } = vi.hoisted(() => ({
  getSshGitProviderMock: vi.fn(),
  indexBuildSpy: vi.fn()
}))

vi.mock('../../../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  requireSshGitProvider: getSshGitProviderMock,
  getSshGitProviderGeneration: () => 1
}))

vi.mock('./ssh-worktree-fallback', async (importOriginal) => {
  const actual = await importOriginal<typeof SshWorktreeFallbackModule>()
  return {
    ...actual,
    // Both builders are counted: the point is that NO index is built on the connected path.
    createSshWorktreeMetaIndex: (...args: Parameters<typeof actual.createSshWorktreeMetaIndex>) => {
      indexBuildSpy('all-hosts', ...args)
      return actual.createSshWorktreeMetaIndex(...args)
    },
    createSshWorktreeMetaIndexForRepo: (
      ...args: Parameters<typeof actual.createSshWorktreeMetaIndexForRepo>
    ) => {
      indexBuildSpy('repo-scoped', ...args)
      return actual.createSshWorktreeMetaIndexForRepo(...args)
    }
  }
})

const { listDetectedWorktreesForCapturedRepo } = await import('./detected-provider-listing')

const repo = {
  id: 'repo-1',
  path: '/home/user/repo',
  displayName: 'repo',
  connectionId: 'conn-1'
} as Repo

const worktreeId = `${repo.id}::/home/user/feature`

function createStore(): Store {
  const rows: Record<string, { instanceId?: string; hostId?: string }> = {
    [worktreeId]: { instanceId: 'instance-1' },
    // Other repos' rows share the host snapshot; only this repo's bucket is ever read back.
    'repo-2::/home/user/other': { instanceId: 'instance-2' }
  }
  return {
    getRepos: () => [repo],
    getRepo: () => repo,
    getSettings: () => ({}),
    getProjectHostSetups: () => [],
    getAllWorktreeLineage: () => ({}),
    getAllWorktreeMeta: () => rows,
    getWorktreeMeta: (id: string) => rows[id],
    setWorktreeMeta: vi.fn()
  } as unknown as Store
}

describe('SSH worktree meta index construction', () => {
  beforeEach(() => {
    indexBuildSpy.mockClear()
    getSshGitProviderMock.mockReset()
  })

  it('does not build the index when the provider answers', async () => {
    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([
        { path: repo.path, head: 'a', branch: 'main', isBare: false, isMainWorktree: true },
        {
          path: '/home/user/feature',
          head: 'b',
          branch: 'feature',
          isBare: false,
          isMainWorktree: false
        }
      ])
    }

    const result = await listDetectedWorktreesForCapturedRepo(
      createStore(),
      repo,
      () => true,
      provider as never
    )

    expect(result).toMatchObject({ authoritative: true, source: 'git' })
    expect(indexBuildSpy).not.toHaveBeenCalled()
  })

  it('builds the index once when no provider is available', async () => {
    const result = await listDetectedWorktreesForCapturedRepo(
      createStore(),
      repo,
      () => true,
      undefined
    )

    expect(result).toMatchObject({ authoritative: false, source: 'metadata-fallback' })
    expect(indexBuildSpy).toHaveBeenCalledTimes(1)
    expect(indexBuildSpy).toHaveBeenCalledWith('all-hosts', expect.anything())
    expect(
      (result as { worktrees: { id: string }[] }).worktrees.map((worktree) => worktree.id)
    ).toEqual([worktreeId])
  })

  it('builds the index once when the provider listing fails', async () => {
    const provider = { listWorktrees: vi.fn().mockRejectedValue(new Error('relay down')) }

    const result = await listDetectedWorktreesForCapturedRepo(
      createStore(),
      repo,
      () => true,
      provider as never
    )

    expect(result).toMatchObject({ authoritative: false, source: 'metadata-fallback' })
    expect(indexBuildSpy).toHaveBeenCalledTimes(1)
    expect(
      (result as { worktrees: { id: string }[] }).worktrees.map((worktree) => worktree.id)
    ).toEqual([worktreeId])
  })
})
