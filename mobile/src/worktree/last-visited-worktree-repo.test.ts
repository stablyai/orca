import { describe, expect, it } from 'vitest'
import { readLastVisitedWorktreeRepoId } from './last-visited-worktree-repo'

describe('last visited worktree repo', () => {
  it('extracts the repo id for the current host', () => {
    const raw = JSON.stringify({ hostId: 'host-1', worktreeId: 'repo-2::/tmp/worktree' })

    expect(readLastVisitedWorktreeRepoId(raw, 'host-1')).toBe('repo-2')
  })

  it('ignores records for another host', () => {
    const raw = JSON.stringify({ hostId: 'host-2', worktreeId: 'repo-2::/tmp/worktree' })

    expect(readLastVisitedWorktreeRepoId(raw, 'host-1')).toBeNull()
  })

  it('ignores malformed stored values', () => {
    expect(readLastVisitedWorktreeRepoId('{', 'host-1')).toBeNull()
    expect(readLastVisitedWorktreeRepoId(JSON.stringify({ hostId: 'host-1' }), 'host-1')).toBeNull()
  })
})
