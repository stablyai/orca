import { describe, expect, it } from 'vitest'
import { markHomeWorktreeCatalogUnavailable, type HostWorktreeInfo } from './home-worktree-info'

describe('markHomeWorktreeCatalogUnavailable', () => {
  it('marks a host unavailable when no catalog has loaded', () => {
    expect(markHomeWorktreeCatalogUnavailable(undefined, 'host-1')).toEqual({
      hostId: 'host-1',
      totalWorktrees: 0,
      activeCount: 0,
      lastActiveWorktree: null,
      catalogUnavailable: true
    })
  })

  it('marks cached counts unavailable without discarding the cached snapshot', () => {
    const current: HostWorktreeInfo = {
      hostId: 'host-1',
      totalWorktrees: 3,
      activeCount: 1,
      lastActiveWorktree: {
        worktreeId: 'worktree-1',
        repo: 'orca',
        branch: 'feature',
        displayName: 'Feature',
        liveTerminalCount: 1
      }
    }

    expect(markHomeWorktreeCatalogUnavailable(current, 'host-1')).toEqual({
      ...current,
      catalogUnavailable: true
    })
  })

  it('reuses an already unavailable snapshot to avoid repeated render churn', () => {
    const current: HostWorktreeInfo = {
      hostId: 'host-1',
      totalWorktrees: 0,
      activeCount: 0,
      lastActiveWorktree: null,
      catalogUnavailable: true
    }

    expect(markHomeWorktreeCatalogUnavailable(current, 'host-1')).toBe(current)
  })
})
