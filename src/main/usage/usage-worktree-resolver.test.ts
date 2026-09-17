import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorktreeLogic from '../ipc/worktree-logic'
import type { UsageScanWorktreeRef } from './usage-provider-contract'

const { worktreePathComparisons } = vi.hoisted(() => ({
  worktreePathComparisons: { count: 0 }
}))

vi.mock('../ipc/worktree-logic', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeLogic>()
  return {
    ...actual,
    areWorktreePathsEqual: (left: string, right: string) => {
      worktreePathComparisons.count += 1
      return actual.areWorktreePathsEqual(left, right)
    }
  }
})

import { createUsageWorktreeResolver } from './usage-worktree-resolver'

function worktree(path: string, index: number): UsageScanWorktreeRef {
  return {
    repoId: `repo-${index}`,
    worktreeId: `repo-${index}::${path}`,
    path,
    displayName: `Repo ${index}`
  }
}

describe('createUsageWorktreeResolver', () => {
  beforeEach(() => {
    worktreePathComparisons.count = 0
  })

  it('walks the worktree list once per distinct cwd, including misses', async () => {
    const resolveWorktree = await createUsageWorktreeResolver(
      Array.from({ length: 50 }, (_, index) =>
        worktree(`/repo-${String(index).padStart(3, '0')}`, index)
      )
    )
    const attribute = (event: number): string | null => {
      const cwd = event % 2 === 0 ? '/repo-049/nested/pkg' : '/outside/project'
      return resolveWorktree(cwd)?.worktreeId ?? null
    }

    expect(attribute(0)).toBe('repo-49::/repo-049')
    expect(attribute(1)).toBeNull()
    const afterFirstOfEachCwd = worktreePathComparisons.count
    expect(afterFirstOfEachCwd).toBeGreaterThan(0)
    expect(afterFirstOfEachCwd).toBeLessThanOrEqual(100)

    for (let event = 2; event < 1_000; event++) {
      expect(attribute(event)).toBe(event % 2 === 0 ? 'repo-49::/repo-049' : null)
    }

    // Two distinct cwds walked the list once each; 998 more events cost nothing.
    expect(worktreePathComparisons.count).toBe(afterFirstOfEachCwd)
  })

  it('keeps containment semantics unchanged', async () => {
    const resolveWorktree = await createUsageWorktreeResolver([worktree('/workspace/repo', 1)])

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

  it('does not treat a different Windows drive as contained', async () => {
    const resolveWorktree = await createUsageWorktreeResolver([worktree('C:\\repo', 1)])

    expect(resolveWorktree('C:\\repo\\packages\\app')?.worktreeId).toBe('repo-1::C:\\repo')
    expect(resolveWorktree('D:\\other\\repo')).toBeNull()
  })

  it('resolves nothing when no worktree is known', async () => {
    const resolveWorktree = await createUsageWorktreeResolver([])
    expect(resolveWorktree('/workspace/repo')).toBeNull()
  })
})
