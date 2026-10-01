import { describe, expect, it } from 'vitest'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { describeMembershipParityMismatch } from './worktree-membership-git-rows'

function row(path: string, overrides: Partial<GitWorktreeInfo> = {}): GitWorktreeInfo {
  return {
    path,
    head: 'a'.repeat(40),
    branch: '',
    isBare: false,
    isMainWorktree: false,
    ...overrides
  }
}

describe('membership parity check', () => {
  const main = row('/repo', { isMainWorktree: true })

  it('ignores linked-row order, which depends on the Git build and locale', () => {
    // Apple Git under a UTF-8 locale folds `É` as Latin-1 and sorts it after `€`; others do not.
    const fileRows = [main, row('/wt/Ébig'), row('/wt/€euro')]
    const gitRows = [main, row('/wt/€euro'), row('/wt/Ébig')]
    expect(describeMembershipParityMismatch(fileRows, gitRows, true)).toBeNull()
  })

  it('still reports a row that differs', () => {
    const fileRows = [main, row('/wt/a'), row('/wt/b', { branch: 'refs/heads/b' })]
    const gitRows = [main, row('/wt/b'), row('/wt/a')]
    expect(describeMembershipParityMismatch(fileRows, gitRows, true)).toMatch(/branch/)
  })
})
