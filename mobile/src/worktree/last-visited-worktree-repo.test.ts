import { describe, expect, it } from 'vitest'

import {
  readLastVisitedWorktreeRecord,
  readLastVisitedWorktreeRepoId
} from './last-visited-worktree-repo'

describe('last visited worktree repo', () => {
  it('ignores records for another host', () => {
    const raw = JSON.stringify({ hostId: 'host-2', worktreeId: 'repo-2::/tmp/worktree' })

    expect(readLastVisitedWorktreeRepoId(raw, 'host-1')).toBeNull()
  })
})

describe('readLastVisitedWorktreeRecord', () => {
  it('reads absent, truncated, and wrong-shaped payloads as no history', () => {
    expect(readLastVisitedWorktreeRecord(null)).toBeNull()
    expect(readLastVisitedWorktreeRecord('')).toBeNull()
    expect(readLastVisitedWorktreeRecord('{"hostId":"host-1"')).toBeNull()
    expect(readLastVisitedWorktreeRecord('null')).toBeNull()
    expect(readLastVisitedWorktreeRecord('"a string"')).toBeNull()
    expect(readLastVisitedWorktreeRecord(JSON.stringify({ hostId: 'host-1' }))).toBeNull()
    expect(
      readLastVisitedWorktreeRecord(JSON.stringify({ hostId: 'host-1', worktreeId: 42 }))
    ).toBeNull()
  })

  it('rejects empty ids that would build a route to nowhere', () => {
    expect(
      readLastVisitedWorktreeRecord(JSON.stringify({ hostId: '', worktreeId: 'repo::/wt' }))
    ).toBeNull()
    expect(
      readLastVisitedWorktreeRecord(JSON.stringify({ hostId: 'host-1', worktreeId: '' }))
    ).toBeNull()
  })
})
