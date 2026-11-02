import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKTREE_ID_SEPARATOR, type ParsedWorktreeId } from '../../shared/worktree/id'
import type * as WorktreeIdModule from '../../shared/worktree/id'

const counter = vi.hoisted(() => ({ splitCalls: 0 }))

// Count per-row parsing to expose O(repos × rows) rescans.
vi.mock('../../shared/worktree/id', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeIdModule>()
  return {
    ...actual,
    splitWorktreeId: (worktreeId: string): ParsedWorktreeId | null => {
      counter.splitCalls += 1
      return actual.splitWorktreeId(worktreeId)
    }
  }
})

const { getLocalRepoForRegisteredWorktree } = await import('./local-worktree-runtime-options')

type TestRepo = { id: string; path: string; connectionId?: string }

const makeStore = (
  repos: readonly TestRepo[],
  worktreeIds: readonly string[]
): { store: never; metaScans: () => number } => {
  let metaScans = 0
  const meta = Object.fromEntries(worktreeIds.map((id) => [id, {}]))
  const store = {
    getRepos: () => repos,
    getAllWorktreeMeta: () => {
      metaScans += 1
      return meta
    }
  }
  return { store: store as never, metaScans: () => metaScans }
}

const worktreeId = (repoId: string, path: string): string =>
  `${repoId}${WORKTREE_ID_SEPARATOR}${path}`

beforeEach(() => {
  counter.splitCalls = 0
})

describe('getLocalRepoForRegisteredWorktree', () => {
  it('walks the worktree meta table once, not once per repo', () => {
    // Put the owner last to expose scans repeated for earlier repos.
    const repoCount = 10
    const rowCount = 200
    const repos = Array.from({ length: repoCount }, (_, i) => ({
      id: `repo-${i}`,
      path: `/repos/repo-${i}`
    }))
    const target = '/repos/repo-9/wt-last'
    const worktreeIds = Array.from({ length: rowCount }, (_, i) =>
      worktreeId(`repo-${i % repoCount}`, `/repos/wt-${i}`)
    )
    worktreeIds[rowCount - 1] = worktreeId(`repo-${repoCount - 1}`, target)
    const { store, metaScans } = makeStore(repos, worktreeIds)

    expect(getLocalRepoForRegisteredWorktree(store, target, target)?.id).toBe('repo-9')
    expect(metaScans()).toBe(1)
    expect(counter.splitCalls).toBe(rowCount)
  })

  describe('equivalence with the per-repo scan', () => {
    const repos: TestRepo[] = [
      { id: 'first', path: '/repos/first' },
      { id: 'middle', path: '/repos/middle' },
      { id: 'last', path: '/repos/last' }
    ]

    it('keeps getRepos precedence when two repos both own the path', () => {
      const { store } = makeStore(repos, [
        worktreeId('last', '/wt/shared'),
        worktreeId('middle', '/wt/shared')
      ])
      // getRepos order decides, not the meta table's insertion order.
      expect(getLocalRepoForRegisteredWorktree(store, '/wt/shared', '/wt/shared')?.id).toBe(
        'middle'
      )
    })

    it('excludes an SSH repo even when it owns the registered worktree', () => {
      const { store } = makeStore(
        [{ id: 'remote', path: '/repos/remote', connectionId: 'm4air' }, ...repos],
        [worktreeId('remote', '/wt/one'), worktreeId('middle', '/wt/one')]
      )
      expect(getLocalRepoForRegisteredWorktree(store, '/wt/one', '/wt/one')?.id).toBe('middle')

      const onlyRemote = makeStore(
        [{ id: 'remote', path: '/repos/remote', connectionId: 'm4air' }],
        [worktreeId('remote', '/wt/one')]
      )
      expect(
        getLocalRepoForRegisteredWorktree(onlyRemote.store, '/wt/one', '/wt/one')
      ).toBeUndefined()
    })

    it('matches the resolved path spelling as well as the raw one', () => {
      const { store } = makeStore(repos, [worktreeId('middle', '/wt/one')])
      expect(getLocalRepoForRegisteredWorktree(store, '/wt/other', '/wt/one')?.id).toBe('middle')
    })
  })
})
