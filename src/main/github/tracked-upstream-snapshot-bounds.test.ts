import { describe, expect, it } from 'vitest'
import {
  _parseTrackedUpstreamBranchesForTests,
  TRACKED_UPSTREAM_SNAPSHOT_MAX_BRANCHES,
  TRACKED_UPSTREAM_SNAPSHOT_MAX_BYTES
} from './client'

describe('tracked upstream snapshot bounds', () => {
  it('caps branch count while preserving the currently requested branch', () => {
    const requested = `branch-${TRACKED_UPSTREAM_SNAPSHOT_MAX_BRANCHES}`
    const stdout = Array.from(
      { length: TRACKED_UPSTREAM_SNAPSHOT_MAX_BRANCHES + 1 },
      (_, index) => `refs/heads/branch-${index}\0refs/remotes/origin/branch-${index}\n`
    ).join('')

    const parsed = _parseTrackedUpstreamBranchesForTests(stdout, requested)
    expect(parsed.size).toBe(TRACKED_UPSTREAM_SNAPSHOT_MAX_BRANCHES)
    expect(parsed.get(requested)).toEqual({
      remoteName: 'origin',
      branchName: requested
    })
    expect(parsed.has('branch-0')).toBe(false)
  })

  it('skips an individual branch that cannot fit the byte budget', () => {
    const oversized = 'x'.repeat(TRACKED_UPSTREAM_SNAPSHOT_MAX_BYTES + 1)
    const parsed = _parseTrackedUpstreamBranchesForTests(
      `refs/heads/${oversized}\0refs/remotes/origin/main\n`,
      oversized
    )
    expect(parsed.size).toBe(0)
  })
})
