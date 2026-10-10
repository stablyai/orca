// A trailing space is a legal POSIX directory name (Google Drive exports them), so the
// worktree selector chain — scan parsing, id minting/parsing, selector matching — must
// preserve it end to end. Characterization: these pass today; a red here means a
// serialization layer started eating the space (#25386 cross-machine selector_not_found).
import { describe, expect, it } from 'vitest'
import { parseWorktreeList } from '../../shared/git-worktree-porcelain-parser'
import {
  splitWorktreeId,
  worktreeIdComparisonKey,
  worktreeIdsEqual
} from '../../shared/worktree/id'
import { runtimePathsEqual } from './runtime-worktree-path-identity'

const REPO_ID = '01234567-89ab-cdef-0123-456789abcdef'
const SPACED_REPO_PATH = '/Users/me/gdrive repo '
const SPACED_WORKTREE_PATH = '/Users/me/orca/workspaces/gdrive repo /feature '

describe('trailing-space paths survive the selector chain', () => {
  it('parses a porcelain scan without trimming the path', () => {
    const output =
      `worktree ${SPACED_REPO_PATH}\nHEAD abc\nbranch refs/heads/main\n\n` +
      `worktree ${SPACED_WORKTREE_PATH}\nHEAD def\nbranch refs/heads/feature\n`

    const worktrees = parseWorktreeList(output)

    expect(worktrees.map((worktree) => worktree.path)).toEqual([
      SPACED_REPO_PATH,
      SPACED_WORKTREE_PATH
    ])
  })

  it('mints and re-splits worktree ids with the space intact', () => {
    const worktreeId = `${REPO_ID}::${SPACED_WORKTREE_PATH}`

    expect(splitWorktreeId(worktreeId)).toEqual({
      repoId: REPO_ID,
      worktreePath: SPACED_WORKTREE_PATH
    })
    expect(worktreeIdsEqual(worktreeId, `${REPO_ID}::${SPACED_WORKTREE_PATH}`)).toBe(true)
    expect(worktreeIdComparisonKey(worktreeId)).toBe(
      `${REPO_ID}::${SPACED_WORKTREE_PATH.normalize('NFC')}`
    )
  })

  it('matches path selectors byte-exact on the trailing space', () => {
    // Interior duplicate slashes fold; the trailing space must survive the fold.
    expect(
      runtimePathsEqual(SPACED_WORKTREE_PATH, SPACED_WORKTREE_PATH.replace('/Users/', '/Users//'))
    ).toBe(true)
    expect(runtimePathsEqual(SPACED_WORKTREE_PATH, SPACED_WORKTREE_PATH.replace(/ $/, ''))).toBe(
      false
    )
  })
})
