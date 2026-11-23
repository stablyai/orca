import { describe, expect, it } from 'vitest'
import { retainUsageSourcesForWorktrees } from './usage-attribution-invalidation'
import { getUsageWorktreeFingerprint } from './usage-worktree-refs'

const fingerprint = (worktrees: { worktreeId: string; path: string; displayName: string }[]) =>
  getUsageWorktreeFingerprint(new Map([['repo', worktrees]]))

const source = (name: string, projectKey: string, worktreeId: string | null = null) => ({
  path: name,
  dailyAggregates: [{ projectKey, worktreeId }],
  sessions: [{ locationBreakdown: [{ locationKey: projectKey, worktreeId }] }]
})

describe('retainUsageSourcesForWorktrees', () => {
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
  const names = (retained: typeof sources) => retained.map((s) => s.path)

  it('re-reads only sources a worktree change can re-attribute', async () => {
    const before = fingerprint([main, feature])
    const added = fingerprint([
      main,
      feature,
      { worktreeId: 'repo::/w/new', path: '/w/new', displayName: 'new' }
    ])
    expect(names(await retainUsageSourcesForWorktrees(sources, before, added))).toEqual([
      'main',
      'feature',
      'sibling',
      'outside',
      'none'
    ])
    const renamed = fingerprint([main, { ...feature, displayName: 'renamed' }])
    expect(names(await retainUsageSourcesForWorktrees(sources, before, renamed))).toEqual([
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
    expect(names(await retainUsageSourcesForWorktrees(sources, before, nested))).not.toContain(
      'main'
    )
  })

  it('drops every source when the cached fingerprint is unreadable', async () => {
    const current = fingerprint([main])
    expect(await retainUsageSourcesForWorktrees(sources, null, current)).toEqual([])
    expect(await retainUsageSourcesForWorktrees(sources, 'not json', current)).toEqual([])
    expect(await retainUsageSourcesForWorktrees(sources, current, current)).toHaveLength(6)
  })
})
