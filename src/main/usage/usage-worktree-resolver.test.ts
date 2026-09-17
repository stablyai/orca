import { describe, expect, it } from 'vitest'
import {
  createUsageWorktreeResolver,
  type CanonicalizedUsageWorktreeRef
} from './usage-worktree-resolver'

/**
 * Counts candidate comparisons: the resolver reads `canonicalPath` once per worktree it tests,
 * so the counter rises only when a cwd actually walks the worktree list.
 */
function countingWorktrees(
  canonicalPaths: readonly string[],
  counter: { comparisons: number }
): CanonicalizedUsageWorktreeRef[] {
  return canonicalPaths.map((canonicalPath, index) => ({
    repoId: `repo-${index}`,
    worktreeId: `repo-${index}::${canonicalPath}`,
    path: canonicalPath,
    displayName: `Repo ${index}`,
    get canonicalPath(): string {
      counter.comparisons += 1
      return canonicalPath
    }
  }))
}

describe('createUsageWorktreeResolver', () => {
  it('walks the worktree list once per distinct cwd, including misses', () => {
    const counter = { comparisons: 0 }
    const worktrees = countingWorktrees(
      Array.from({ length: 50 }, (_, index) => `/repo-${String(index).padStart(3, '0')}`),
      counter
    )
    const resolveWorktree = createUsageWorktreeResolver(worktrees)
    const attribute = (event: number): string | null => {
      const cwd = event % 2 === 0 ? '/repo-049/nested/pkg' : '/outside/project'
      return resolveWorktree(cwd)?.worktreeId ?? null
    }

    expect(attribute(0)).toBe('repo-49::/repo-049')
    expect(attribute(1)).toBeNull()
    const afterFirstOfEachCwd = counter.comparisons
    expect(afterFirstOfEachCwd).toBeGreaterThan(0)

    for (let event = 2; event < 1_000; event++) {
      expect(attribute(event)).toBe(event % 2 === 0 ? 'repo-49::/repo-049' : null)
    }

    // Two distinct cwds walked the list once each; 998 more events cost nothing.
    expect(counter.comparisons).toBe(afterFirstOfEachCwd)
  })

  it('memoizes each cwd independently', () => {
    const counter = { comparisons: 0 }
    const resolveWorktree = createUsageWorktreeResolver(
      countingWorktrees(['/repo-a', '/repo-b'], counter)
    )

    expect(resolveWorktree('/repo-b')?.worktreeId).toBe('repo-1::/repo-b')
    const afterFirst = counter.comparisons
    expect(resolveWorktree('/repo-a')?.worktreeId).toBe('repo-0::/repo-a')
    expect(counter.comparisons).toBeGreaterThan(afterFirst)
    const afterSecond = counter.comparisons
    resolveWorktree('/repo-b')
    resolveWorktree('/repo-a')
    expect(counter.comparisons).toBe(afterSecond)
  })

  it('keeps containment semantics unchanged', () => {
    const resolveWorktree = createUsageWorktreeResolver([
      {
        repoId: 'repo-1',
        worktreeId: 'repo-1::/workspace/repo',
        path: '/workspace/repo',
        displayName: 'Repo',
        canonicalPath: '/workspace/repo'
      }
    ])

    expect(resolveWorktree('/workspace/repo')?.worktreeId).toBe('repo-1::/workspace/repo')
    expect(resolveWorktree('/workspace/repo/packages/app')?.worktreeId).toBe(
      'repo-1::/workspace/repo'
    )
    // `..name` is a child directory; `..` escapes.
    expect(resolveWorktree('/workspace/repo/..fixtures/session')?.worktreeId).toBe(
      'repo-1::/workspace/repo'
    )
    expect(resolveWorktree('/workspace/repo/../other/session')).toBeNull()
    expect(resolveWorktree('/workspace/repo-sibling')).toBeNull()
  })

  it('does not treat a different Windows drive as contained', () => {
    const resolveWorktree = createUsageWorktreeResolver([
      {
        repoId: 'repo-1',
        worktreeId: 'repo-1::C:\\repo',
        path: 'C:\\repo',
        displayName: 'Repo',
        canonicalPath: 'C:\\repo'
      }
    ])

    expect(resolveWorktree('C:\\repo\\packages\\app')?.worktreeId).toBe('repo-1::C:\\repo')
    expect(resolveWorktree('D:\\other\\repo')).toBeNull()
  })

  it('resolves nothing when no worktree is known', () => {
    const resolveWorktree = createUsageWorktreeResolver([])
    expect(resolveWorktree('/workspace/repo')).toBeNull()
  })
})
