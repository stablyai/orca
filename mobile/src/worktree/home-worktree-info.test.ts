import { describe, expect, it } from 'vitest'
import {
  homeHostWorktreeSummary,
  markHomeWorktreeCatalogUnavailable,
  type HostWorktreeInfo
} from './home-worktree-info'

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
      catalogUnavailable: true,
      staleCounts: true
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

describe('homeHostWorktreeSummary', () => {
  const provenAt = 1_700_000_000_000
  const loaded: HostWorktreeInfo = {
    hostId: 'host-1',
    totalWorktrees: 12,
    activeCount: 2,
    lastActiveWorktree: null,
    countsProvenAt: provenAt
  }

  it('summarizes a loaded catalog', () => {
    expect(homeHostWorktreeSummary(loaded)).toBe('12 worktrees · 2 active')
    expect(homeHostWorktreeSummary({ ...loaded, totalWorktrees: 1, activeCount: 0 })).toBe(
      '1 worktree'
    )
  })

  it('keeps showing the last proven counts after a failed refresh', () => {
    expect(homeHostWorktreeSummary(markHomeWorktreeCatalogUnavailable(loaded, 'host-1'))).toBe(
      '12 worktrees · 2 active'
    )
  })

  it('reports unavailable only when no catalog ever loaded', () => {
    expect(homeHostWorktreeSummary(markHomeWorktreeCatalogUnavailable(undefined, 'host-1'))).toBe(
      'Worktree list unavailable'
    )
    expect(homeHostWorktreeSummary(undefined)).toBeNull()
  })
})
