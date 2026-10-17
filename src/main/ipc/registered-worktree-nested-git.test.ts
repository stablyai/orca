import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isDescendantOrEqual } from './filesystem-path-containment'
import {
  findLongestRegisteredAncestor,
  isNestedGitRootInside,
  worktreePathBelongsToRepo
} from './registered-worktree-nested-git'

describe('findLongestRegisteredAncestor', () => {
  it('picks the longest matching registered root', () => {
    expect(findLongestRegisteredAncestor('/ws/.worktrees/001/theme-a', ['/ws', '/other'])).toBe(
      '/ws'
    )
    expect(
      findLongestRegisteredAncestor('/ws/.worktrees/001/theme-a', ['/ws', '/ws/.worktrees/001'])
    ).toBe('/ws/.worktrees/001')
    expect(findLongestRegisteredAncestor('/tmp/x', ['/ws'])).toBeNull()
  })
})

describe('isNestedGitRootInside', () => {
  it('accepts the ancestor itself and a descendant git root, not a plain folder', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'orca-nested-git-root-'))
    const nested = join(scratch, 'theme-a')
    const plain = join(scratch, 'files')
    await mkdir(join(nested, '.git'), { recursive: true })
    await mkdir(plain, { recursive: true })
    try {
      expect(await isNestedGitRootInside(scratch, scratch, isDescendantOrEqual)).toBe(true)
      expect(await isNestedGitRootInside(nested, scratch, isDescendantOrEqual)).toBe(true)
      expect(await isNestedGitRootInside(plain, scratch, isDescendantOrEqual)).toBe(false)
      expect(await isNestedGitRootInside('/other', scratch, isDescendantOrEqual)).toBe(false)
      expect(await worktreePathBelongsToRepo(nested, scratch, [scratch], isDescendantOrEqual)).toBe(
        true
      )
      expect(await worktreePathBelongsToRepo(plain, scratch, [scratch], isDescendantOrEqual)).toBe(
        false
      )
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})
