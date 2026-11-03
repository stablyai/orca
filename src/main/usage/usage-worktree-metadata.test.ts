import { describe, expect, it } from 'vitest'
import { loadKnownUsageWorktreesByRepo } from './usage-worktree-metadata'

describe('loadKnownUsageWorktreesByRepo', () => {
  it('indexes repos once for many persisted worktrees', () => {
    const repoCount = 200
    let repoIdReads = 0
    const repos = Array.from({ length: repoCount }, (_, index) => ({
      get id() {
        repoIdReads += 1
        return `repo-${index}`
      },
      path: `/workspace/repo-${index}`,
      displayName: `Repo ${index}`
    }))
    const worktreeMeta = Object.fromEntries(
      Array.from({ length: repoCount }, (_, offset) => {
        const index = repoCount - offset - 1
        return [
          `repo-${index}::/workspace/repo-${index}-feature`,
          { displayName: `Feature ${index}` }
        ]
      })
    )

    const result = loadKnownUsageWorktreesByRepo(
      { getAllWorktreeMeta: () => worktreeMeta } as never,
      repos as never
    )

    expect(result.size).toBe(repoCount)
    expect([...result.values()].every((worktrees) => worktrees.length === 2)).toBe(true)
    expect(repoIdReads).toBeLessThanOrEqual(repoCount * 4)
  })
})
