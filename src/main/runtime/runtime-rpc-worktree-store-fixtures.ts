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
  updateRepo: (id: string, updates: Record<string, unknown>) =>
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
  setWorktreeMeta: (_worktreeId: string, meta: Record<string, unknown>) =>
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
