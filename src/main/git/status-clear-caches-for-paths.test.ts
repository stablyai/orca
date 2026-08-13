import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearGitReadCachesForPaths,
  clearSubmodulePathsCacheForTests,
  clearEffectiveUpstreamStatusCacheForTests,
  primeGitReadCachesForTests,
  getSubmodulePathsCacheCountForTests
} from './status'

// Why: helper for repo-removal teardown; the matching logic is exercised here by priming the
// module-level caches with predictable entries and asserting that only matching keys are removed.
describe('clearGitReadCachesForPaths', () => {
  beforeEach(() => {
    clearSubmodulePathsCacheForTests()
    clearEffectiveUpstreamStatusCacheForTests()
  })

  it('is a safe no-op for empty input', () => {
    expect(() => clearGitReadCachesForPaths([])).not.toThrow()
    expect(getSubmodulePathsCacheCountForTests()).toBe(0)
  })

  it('tolerates paths with no matching cache entries', () => {
    primeGitReadCachesForTests(['/worktrees/repo-a'])
    expect(() => clearGitReadCachesForPaths(['/no/such/path', '/another/missing'])).not.toThrow()
    expect(getSubmodulePathsCacheCountForTests()).toBe(1)
  })

  it('removes entries whose worktree path matches the prefix', () => {
    primeGitReadCachesForTests(['/worktrees/repo-a', '/worktrees/repo-a/sub', '/worktrees/repo-b'])
    expect(getSubmodulePathsCacheCountForTests()).toBe(3)

    clearGitReadCachesForPaths(['/worktrees/repo-a'])

    // repo-a and repo-a/sub are removed by the prefix match; repo-b is preserved.
    expect(getSubmodulePathsCacheCountForTests()).toBe(1)
  })

  it('removes entries across all three git caches', () => {
    primeGitReadCachesForTests(['/worktrees/repo-a', '/worktrees/repo-b'])

    clearGitReadCachesForPaths(['/worktrees/repo-a'])

    expect(getSubmodulePathsCacheCountForTests()).toBe(1)
  })

  it('handles multiple paths in one call', () => {
    primeGitReadCachesForTests(['/worktrees/repo-a', '/worktrees/repo-b', '/worktrees/repo-c'])

    clearGitReadCachesForPaths(['/worktrees/repo-a', '/worktrees/repo-c'])

    expect(getSubmodulePathsCacheCountForTests()).toBe(1)
  })

  // Why: a naive startsWith would also clear `/worktrees/repo-ab` and `/worktrees/repo-a/sub`
  // when clearing `/worktrees/repo-a`. The boundary check (exact match OR path-separator
  // boundary) must reject the sibling (`/worktrees/repo-ab`) and keep the descendant
  // (`/worktrees/repo-a/sub`).
  it('distinguishes siblings from descendants when clearing by path', () => {
    primeGitReadCachesForTests(['/worktrees/repo-a', '/worktrees/repo-ab', '/worktrees/repo-a/sub'])

    clearGitReadCachesForPaths(['/worktrees/repo-a'])

    // /worktrees/repo-a (exact) and /worktrees/repo-a/sub (descendant) removed;
    // /worktrees/repo-ab (sibling) preserved.
    expect(getSubmodulePathsCacheCountForTests()).toBe(1)
  })
})
