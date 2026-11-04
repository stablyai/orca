import { describe, expect, it } from 'vitest'
import { multiRepoDeleteRowStatus } from './multi-repo-delete-sheet-model'

describe('multi-repo delete row status', () => {
  const member = (dirtyCount: number | null, unpublishedCommitCount: number | null) => ({
    memberId: 'm',
    repoId: 'r',
    state: 'ready',
    worktreeId: 'w',
    worktreeExists: true,
    willKeepBranch: null,
    dirtyCount,
    unpublishedCommitCount
  })

  it('pluralizes uncommitted files and unpublished commits', () => {
    expect(multiRepoDeleteRowStatus(member(1, 0)).text).toBe('1 uncommitted file')
    expect(multiRepoDeleteRowStatus(member(2, 0)).text).toBe('2 uncommitted files')
    expect(multiRepoDeleteRowStatus(member(0, 1)).text).toBe('1 unpublished commit')
    expect(multiRepoDeleteRowStatus(member(0, 3)).text).toBe('3 unpublished commits')
  })
})
