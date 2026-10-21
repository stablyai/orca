/** An SSH repo lists from its persisted rows, building the worktree-meta index exactly once. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Store } from '../../../persistence/loading-store/store'
import type * as SshWorktreeFallbackModule from './ssh-worktree-fallback'

const { indexBuildSpy } = vi.hoisted(() => ({ indexBuildSpy: vi.fn() }))

vi.mock('./ssh-worktree-fallback', async (importOriginal) => {
  const actual = await importOriginal<typeof SshWorktreeFallbackModule>()
  return {
    ...actual,
    // Both builders are counted, so a second build of either kind shows up.
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
  })

  it('builds the index once for an SSH repo', async () => {
    const result = await listDetectedWorktreesForCapturedRepo(createStore(), repo, () => true)

    expect(result).toMatchObject({ authoritative: false, source: 'metadata-fallback' })
    expect(indexBuildSpy).toHaveBeenCalledTimes(1)
    expect(indexBuildSpy).toHaveBeenCalledWith('all-hosts', expect.anything())
    expect(
      (result as { worktrees: { id: string }[] }).worktrees.map((worktree) => worktree.id)
    ).toEqual([worktreeId])
  })
})
