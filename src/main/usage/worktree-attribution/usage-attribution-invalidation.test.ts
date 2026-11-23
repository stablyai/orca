import { describe, expect, it } from 'vitest'
import { reattributeUsageSourcesForWorktrees } from './usage-attribution-invalidation'
import { getUsageWorktreeFingerprint } from './usage-worktree-refs'

const fingerprint = (worktrees: { worktreeId: string; path: string; displayName: string }[]) =>
  getUsageWorktreeFingerprint(new Map([['repo', worktrees]]))

const source = (name: string, projectKey: string, worktreeId: string | null = null) => ({
  path: name,
  dailyAggregates: [{ projectKey, worktreeId }],
  sessions: [{ locationBreakdown: [{ locationKey: projectKey, worktreeId }] }]
})

describe('reattributeUsageSourcesForWorktrees', () => {
  const main = { worktreeId: 'repo::/r', path: '/r', displayName: 'r' }
  const feature = { worktreeId: 'repo::/w/feature', path: '/w/feature', displayName: 'feature' }
  const sources = [
    source('main', `worktree:${main.worktreeId}`, main.worktreeId),
    source('feature', `worktree:${feature.worktreeId}`, feature.worktreeId),
    source('inside-new', 'cwd:/w/new/src'),
    source('sibling', 'cwd:/w/newer'),
    source('outside', 'cwd:/elsewhere'),
    source('none', 'unscoped')
  ]
  // Affected sources stay (ownership checks need them) but are marked to be re-read.
  const names = (retained: typeof sources) => {
    expect(retained.map((s) => s.path)).toEqual(sources.map((s) => s.path))
    return retained.filter((s) => !('mtimeMs' in s && s.mtimeMs === -1)).map((s) => s.path)
  }

  it('re-reads only sources a worktree change can re-attribute', async () => {
    const before = fingerprint([main, feature])
    const added = fingerprint([
      main,
      feature,
      { worktreeId: 'repo::/w/new', path: '/w/new', displayName: 'new' }
    ])
    expect(names(await reattributeUsageSourcesForWorktrees(sources, before, added))).toEqual([
      'main',
      'feature',
      'sibling',
      'outside',
      'none'
    ])
    const renamed = fingerprint([main, { ...feature, displayName: 'renamed' }])
    expect(names(await reattributeUsageSourcesForWorktrees(sources, before, renamed))).toEqual([
      'main',
      'inside-new',
      'sibling',
      'outside',
      'none'
    ])
    const nested = fingerprint([
      main,
      feature,
      { worktreeId: 'repo::/r/sub', path: '/r/sub', displayName: 'sub' }
    ])
    expect(names(await reattributeUsageSourcesForWorktrees(sources, before, nested))).not.toContain(
      'main'
    )
  })

  it('drops every source when the cached fingerprint is unreadable', async () => {
    const current = fingerprint([main])
    expect(await reattributeUsageSourcesForWorktrees(sources, null, current)).toEqual([])
    expect(await reattributeUsageSourcesForWorktrees(sources, 'not json', current)).toEqual([])
    expect(await reattributeUsageSourcesForWorktrees(sources, current, current)).toHaveLength(6)
  })
})
