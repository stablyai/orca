import { describe, expect, it } from 'vitest'
import { cachedWorktreePathsForScope } from './worktree-head-identity-cached-paths'
import { createWorktreeHeadIdentityCache } from './worktree-head-identity-reader'
import { headIdentityScopeForEntry } from './worktree-head-identity-scope'

const HEAD = 'a'.repeat(40)

describe('cachedWorktreePathsForScope', () => {
  it('names every checkout whose admin dir folds to the same key', () => {
    // Case-sensitive filesystems let Git create both `Foo` and `foo` admin dirs.
    const cache = createWorktreeHeadIdentityCache()
    cache.entries.set('Foo', { worktreePath: '/a/Foo', head: HEAD, branch: 'refs/heads/x' })
    cache.entries.set('foo', { worktreePath: '/b/foo', head: HEAD, branch: 'refs/heads/y' })

    const paths = cachedWorktreePathsForScope(cache, headIdentityScopeForEntry('Foo'))

    expect(paths).toEqual(expect.arrayContaining(['/a/Foo', '/b/foo']))
  })

  it('stays unattributed when an entry is not in the memo', () => {
    const cache = createWorktreeHeadIdentityCache()
    expect(cachedWorktreePathsForScope(cache, headIdentityScopeForEntry('wt'))).toBeNull()
  })
})
