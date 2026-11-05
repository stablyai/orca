import { describe, expect, it } from 'vitest'

import { countHandBuiltWorktreeIds, isScannedPath } from './check-worktree-id-composer-ratchet.mjs'

describe('countHandBuiltWorktreeIds', () => {
  it('counts a repo id joined to a path by a literal or constant separator', () => {
    expect(countHandBuiltWorktreeIds('const id = `${repo.id}::${worktree.path}`')).toBe(1)
    expect(countHandBuiltWorktreeIds('f(`${repoId}::${gitWorktree.path}`)')).toBe(1)
    expect(
      countHandBuiltWorktreeIds('`${args.repoId}${WORKTREE_ID_SEPARATOR}${newPath}${suffix}`')
    ).toBe(1)
    expect(countHandBuiltWorktreeIds('[`${repo.id}::${a.path}`, `${repoId}::${b.path}`]')).toBe(2)
  })

  it('ignores comments and non-worktree keys', () => {
    expect(
      countHandBuiltWorktreeIds('// ids are `${repoId}::${path}`\n/* `${repo.id}::${p.path}` */')
    ).toBe(0)
    expect(countHandBuiltWorktreeIds('`${owner}::${repoName}`')).toBe(0)
    expect(countHandBuiltWorktreeIds('composeWorktreeId(repo.id, worktree.path)')).toBe(0)
  })
})

describe('isScannedPath', () => {
  it('scans production sources outside the composer module', () => {
    expect(isScannedPath('src/main/runtime/a.ts')).toBe(true)
    expect(isScannedPath('mobile/src/session/a.tsx')).toBe(true)
    expect(isScannedPath('src/shared/worktree/id.ts')).toBe(false)
    expect(isScannedPath('src/main/a.test.ts')).toBe(false)
    expect(isScannedPath('src/main/runtime/__fixtures__/a.ts')).toBe(false)
    expect(isScannedPath('src/renderer/src/store/host-twin.test-fixture.ts')).toBe(false)
    expect(isScannedPath('config/scripts/a.mjs')).toBe(false)
  })
})
