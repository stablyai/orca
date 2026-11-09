import { describe, expect, it } from 'vitest'
import { setCachedWorktrees, getCachedWorktrees } from './worktree-cache'

// A persisted cold-start seed must not truncate the rows a live worktree.ps listed.
describe('worktree-cache provenance', () => {
  it('keeps a fresh host-listed catalog when a cold-start seed lands after it', () => {
    const hostId = 'host-kept'
    const listed = [{ worktreeId: 'a' }, { worktreeId: 'b' }]
    setCachedWorktrees(hostId, listed, { proven: true })

    setCachedWorktrees(hostId, [{ worktreeId: 'a' }])

    expect(getCachedWorktrees(hostId)).toEqual(listed)
  })
})
