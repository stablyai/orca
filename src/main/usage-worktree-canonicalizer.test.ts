import { describe, expect, it } from 'vitest'
import {
  USAGE_WORKTREE_CANONICALIZATION_CONCURRENCY,
  canonicalizeUsageWorktreePaths
} from './usage-worktree-canonicalizer'

describe('canonicalizeUsageWorktreePaths', () => {
  it('caps concurrent canonicalization work and preserves longest-path-first ordering', async () => {
    let active = 0
    let maxActive = 0
    const seenPaths: string[] = []

    const worktrees = Array.from(
      { length: USAGE_WORKTREE_CANONICALIZATION_CONCURRENCY + 3 },
      (_value, index) => ({
        path: `/repo/${index}`,
        worktreeId: `worktree-${index}`
      })
    )

    const result = await canonicalizeUsageWorktreePaths(worktrees, async (path) => {
      active++
      maxActive = Math.max(maxActive, active)
      seenPaths.push(path)
      await new Promise((resolve) => setTimeout(resolve, 0))
      active--
      return path.endsWith('/10') ? `${path}/nested/longer` : path
    })

    expect(maxActive).toBeLessThanOrEqual(USAGE_WORKTREE_CANONICALIZATION_CONCURRENCY)
    expect(seenPaths).toEqual(worktrees.map((worktree) => worktree.path))
    expect(result[0]).toMatchObject({
      path: '/repo/10',
      canonicalPath: '/repo/10/nested/longer'
    })
  })
})
