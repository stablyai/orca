import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { reattributeUsageSourcesForWorktrees } from './usage-attribution-invalidation'
import { getUsageWorktreeFingerprint } from './usage-worktree-refs'

const fingerprint = (worktrees: { worktreeId: string; path: string; displayName: string }[]) =>
  getUsageWorktreeFingerprint(new Map([['repo', worktrees]]))

const source = (
  name: string,
  projectKey: string,
  worktreeId: string | null = null,
  hasDeferredClaims = false
) => ({
  path: name,
  hasDeferredClaims,
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

  it('treats a removed macOS /private/tmp alias as the same worktree path', async () => {
    const alias = [source('aliased', 'cwd:/private/tmp/orca-removed-wt/src')]
    const added = fingerprint([
      main,
      { worktreeId: 'repo::/tmp/orca-removed-wt', path: '/tmp/orca-removed-wt', displayName: 'x' }
    ])
    const retained = await reattributeUsageSourcesForWorktrees(alias, fingerprint([main]), added)
    if (process.platform === 'darwin') {
      expect(retained[0]).toMatchObject({ mtimeMs: -1 })
    } else {
      expect(retained[0]).not.toHaveProperty('mtimeMs')
    }
  })

  it('follows a symlinked cwd only for providers whose attribution resolves it', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-attribution-link-')))
    try {
      await mkdir(join(root, 'real', 'src'), { recursive: true })
      await symlink(join(root, 'real'), join(root, 'link'), 'junction')
      const linked = [source('linked', `cwd:${join(root, 'link', 'src')}`)]
      const added = fingerprint([
        main,
        { worktreeId: `repo::${join(root, 'real')}`, path: join(root, 'real'), displayName: 'r' }
      ])
      const marked = async (attributionResolvesCwd: boolean) =>
        (
          await reattributeUsageSourcesForWorktrees(linked, fingerprint([main]), added, {
            attributionResolvesCwd
          })
        )[0]
      expect(await marked(true)).toMatchObject({ mtimeMs: -1 })
      expect(await marked(false)).not.toHaveProperty('mtimeMs')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('re-reads deferred forks whenever any source is re-read, since their owner may release turns', async () => {
    const fork = source('fork', 'cwd:/elsewhere', null, true)
    const before = fingerprint([main, feature])
    const renamed = fingerprint([main, { ...feature, displayName: 'renamed' }])
    const marked = (list: unknown[]) =>
      list.filter((s) => typeof s === 'object' && s !== null && 'mtimeMs' in s).length
    expect(
      marked(await reattributeUsageSourcesForWorktrees([...sources, fork], before, renamed))
    ).toBe(2)
    const unaffected = fingerprint([main, feature, { ...main, worktreeId: 'repo::/x', path: '/x' }])
    expect(marked(await reattributeUsageSourcesForWorktrees([fork], before, unaffected))).toBe(0)
  })
})
