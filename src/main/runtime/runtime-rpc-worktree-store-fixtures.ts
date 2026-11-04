import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import type { listWorktrees } from '../git/worktrees/catalog/worktree-scan-cache'
import type { listWorktreesStrict } from '../git/worktrees/catalog/worktree-listing'
export const makeStore = (overrides?: { isUnread?: boolean }) => ({
  getRepo: (id: string) =>
    makeStore(overrides)
      .getRepos()
      .find((repo) => repo.id === id),
  getRepos: () => [
    {
      id: 'repo-1',
      path: '/tmp/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1
    }
  ],
  addRepo: () => {},
  updateRepo: ({ id }: { id: string }, updates: Record<string, unknown>) =>
    ({
      ...makeStore(overrides).getRepo(id),
      ...updates
    }) as never,
  getAllWorktreeMeta: () => ({
    'repo-1::/tmp/worktree-a': {
      displayName: 'foo',
      comment: '',
      linkedIssue: 123,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: overrides?.isUnread ?? false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0
    }
  }),
  getWorktreeMeta: (worktreeId: string) =>
    worktreeId === 'repo-1::/tmp/worktree-a'
      ? (makeStore(overrides).getAllWorktreeMeta()[worktreeId] as never)
      : undefined,
  setWorktreeMeta: (_target: HostWorktreeTarget, meta: Record<string, unknown>) =>
    ({
      ...makeStore(overrides).getAllWorktreeMeta()['repo-1::/tmp/worktree-a'],
      ...meta
    }) as never,
  removeWorktreeMeta: () => {},
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    branchPrefix: 'none',
    branchPrefixCustom: ''
  })
})

export function createWorktreeListingMocks(): {
  listWorktrees: Mock<typeof listWorktrees>
  listWorktreesStrict: Mock<typeof listWorktreesStrict>
} {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
}
