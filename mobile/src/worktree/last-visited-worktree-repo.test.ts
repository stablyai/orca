import { describe, expect, it, vi } from 'vitest'
import {
  LAST_VISITED_WORKTREE_MAX_ID_CHARACTERS,
  LAST_VISITED_WORKTREE_MAX_STORAGE_CHARACTERS,
  readLastVisitedWorktreeRecord,
  readLastVisitedWorktreeRepoId,
  serializeLastVisitedWorktreeRecord
} from './last-visited-worktree-repo'

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

  it('round-trips exact field limits and rejects one character more', () => {
    const exact = {
      hostId: 'h'.repeat(LAST_VISITED_WORKTREE_MAX_ID_CHARACTERS),
      worktreeId: 'w'.repeat(LAST_VISITED_WORKTREE_MAX_ID_CHARACTERS)
    }
    const serialized = serializeLastVisitedWorktreeRecord(exact)

    expect(serialized).not.toBeNull()
    expect(readLastVisitedWorktreeRecord(serialized)).toEqual(exact)
    expect(
      serializeLastVisitedWorktreeRecord({
        ...exact,
        worktreeId: `${exact.worktreeId}w`
      })
    ).toBeNull()
  })

  it('accepts the exact raw limit and does not parse one character more', () => {
    const record = { hostId: 'host-1', worktreeId: 'repo::worktree' }
    const serialized = JSON.stringify(record)
    const exact =
      serialized + ' '.repeat(LAST_VISITED_WORKTREE_MAX_STORAGE_CHARACTERS - serialized.length)

    expect(readLastVisitedWorktreeRecord(exact)).toEqual(record)

    const parse = vi.spyOn(JSON, 'parse')
    expect(
      readLastVisitedWorktreeRecord('x'.repeat(LAST_VISITED_WORKTREE_MAX_STORAGE_CHARACTERS + 1))
    ).toBeNull()
    expect(parse).not.toHaveBeenCalled()
    parse.mockRestore()
  })
})
