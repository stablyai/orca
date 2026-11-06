import { describe, expect, it } from 'vitest'
import { WORKTREE_ID_SEPARATOR } from '../../shared/terminal/pty/lifecycle/pty-session-id-format'

const { getLocalRepoForRegisteredWorktree } = await import('./local-worktree-runtime-options')

type TestRepo = { id: string; path: string; connectionId?: string }

const makeStore = (
  repos: readonly TestRepo[],
  worktreeIds: readonly string[]
): { store: never } => {
  const meta = Object.fromEntries(worktreeIds.map((id) => [id, {}]))
  const store = {
    getRepos: () => repos,
    getAllWorktreeMeta: () => meta
  }
  // SAFETY: This fixture supplies the catalog methods used by the repo lookup.
  return { store: store as never }
}

const worktreeId = (repoId: string, path: string): string =>
  `${repoId}${WORKTREE_ID_SEPARATOR}${path}`

describe('getLocalRepoForRegisteredWorktree', () => {
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
