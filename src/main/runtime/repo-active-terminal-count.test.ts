import { describe, expect, it } from 'vitest'
import { countActiveRepoTerminals } from './repo-active-terminal-count'

describe('countActiveRepoTerminals', () => {
  it('counts only connected ptys whose worktree belongs to the repo', () => {
    const ptys = [
      { worktreeId: 'repo-a::/abs/a', connected: true },
      { worktreeId: 'repo-a::/abs/a-two', connected: true },
      { worktreeId: 'repo-b::/abs/b', connected: true },
      { worktreeId: 'repo-a::/abs/a-three', connected: false }
    ]

    expect(countActiveRepoTerminals(ptys, 'repo-a')).toBe(2)
  })

  it('ignores disconnected ptys even when they belong to the repo', () => {
    const ptys = [{ worktreeId: 'repo-a::/abs/a', connected: false }]

    expect(countActiveRepoTerminals(ptys, 'repo-a')).toBe(0)
  })

  it('returns zero when no pty matches the repo id', () => {
    const ptys = [{ worktreeId: 'repo-b::/abs/b', connected: true }]

    expect(countActiveRepoTerminals(ptys, 'repo-a')).toBe(0)
  })

  it('does not false-match a repo id that is a substring of another worktree id', () => {
    // Why: a naive startsWith(repoId) check would wrongly match `repo-a-extra`.
    const ptys = [{ worktreeId: 'repo-a-extra::/abs/x', connected: true }]

    expect(countActiveRepoTerminals(ptys, 'repo-a')).toBe(0)
  })

  it('handles worktree ids whose path itself contains the separator', () => {
    const ptys = [{ worktreeId: 'repo-a::/abs/with::colons', connected: true }]

    expect(countActiveRepoTerminals(ptys, 'repo-a')).toBe(1)
    expect(countActiveRepoTerminals(ptys, 'repo-a::/abs')).toBe(0)
  })

  it('returns zero for an empty pty set', () => {
    expect(countActiveRepoTerminals([], 'repo-a')).toBe(0)
  })
})
