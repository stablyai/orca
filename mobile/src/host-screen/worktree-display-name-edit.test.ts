import { describe, expect, it } from 'vitest'
import type { Worktree } from '../worktree/workspace-list-types'
import {
  automaticWorktreeDisplayName,
  renamedWorktreeRows,
  worktreeDisplayNameUpdate
} from './worktree-display-name-edit'

describe('worktreeDisplayNameUpdate', () => {
  it('sends the trimmed name only when it differs from the one shown', () => {
    expect(worktreeDisplayNameUpdate('feature-a', '  Feature A  ')).toBe('Feature A')
    expect(worktreeDisplayNameUpdate('Feature A', ' Feature A ')).toBeNull()
  })

  it('sends empty text as the blanking write that returns the label to automatic', () => {
    expect(worktreeDisplayNameUpdate('Feature A', '   ')).toBe('')
  })
})

describe('automaticWorktreeDisplayName', () => {
  it('reads the branch without refs/heads/, then the folder, then the repo', () => {
    expect(
      automaticWorktreeDisplayName({ branch: 'refs/heads/feat/x', path: '/w/x', repo: 'orca' })
    ).toBe('feat/x')
    expect(automaticWorktreeDisplayName({ branch: '', path: '/w/scratch/', repo: 'orca' })).toBe(
      'scratch'
    )
    expect(automaticWorktreeDisplayName({ branch: '', path: '', repo: 'orca' })).toBe('orca')
  })
})

describe('renamedWorktreeRows', () => {
  it('relabels only the row on the same host', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rename reads only the identity members and spreads the rest.
    const rows = [
      { worktreeId: 'wt', hostId: 'local', displayName: 'a' },
      { worktreeId: 'wt', hostId: 'runtime:vm', displayName: 'b' }
    ] as Worktree[]
    expect(
      renamedWorktreeRows(rows, { worktreeId: 'wt', hostId: 'runtime:vm' }, 'B').map(
        (row) => row.displayName
      )
    ).toEqual(['a', 'B'])
  })
})
