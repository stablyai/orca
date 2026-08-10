import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearGitReadCachesForPaths,
  clearSubmodulePathsCacheForTests,
  getSubmodulePathsCacheCountForTests
} from './status'

// Why: helper for repo-removal teardown; the actual sweep is exercised by the git-cached
// integration tests once a path is registered. This file documents the no-op contract and
// keeps the export reachable from a single test surface so a regression in the helper's
// import path is caught fast.

describe('clearGitReadCachesForPaths', () => {
  beforeEach(() => {
    clearSubmodulePathsCacheForTests()
  })

  it('is a safe no-op for empty input', () => {
    expect(() => clearGitReadCachesForPaths([])).not.toThrow()
    expect(getSubmodulePathsCacheCountForTests()).toBe(0)
  })

  it('tolerates paths with no matching cache entries', () => {
    expect(() => clearGitReadCachesForPaths(['/no/such/path', '/another/missing'])).not.toThrow()
    expect(getSubmodulePathsCacheCountForTests()).toBe(0)
  })
})
