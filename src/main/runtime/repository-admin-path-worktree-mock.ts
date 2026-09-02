// Mock state for the repository-admin-path suites. Kept free of imports from the modules under
// test so a `vi.mock` factory can load it without re-entering the runtime's own `git/worktree`.

export const listedWorktrees: { path: string }[] = []

/** Reports only the fixture's own worktree, so selectors resolve without scanning a real repo. */
export function worktreeModuleMock() {
  const listed = async () =>
    listedWorktrees.map((entry) => ({
      path: entry.path,
      head: 'abc',
      branch: 'main',
      isBare: false,
      isMainWorktree: true
    }))
  return { listWorktrees: listed, listWorktreesStrict: listed }
}
