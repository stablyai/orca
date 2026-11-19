import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repository/repo-types'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { collapsePathEqualWorktreeRows } from './path-equal-worktree-rows'

const repo: Repo = { id: 'repo', path: '/x/repo', displayName: 'repo', badgeColor: '', addedAt: 0 }
const main: GitWorktreeInfo = {
  path: '/x/repo',
  head: 'aaa',
  branch: 'refs/heads/main',
  isBare: false,
  isMainWorktree: true
}
const detached: GitWorktreeInfo = {
  path: '/x//task',
  head: 'aaa',
  branch: '',
  isBare: false,
  isMainWorktree: false
}
const onBranch: GitWorktreeInfo = {
  path: '/x/task',
  head: 'bbb',
  branch: 'refs/heads/task',
  isBare: false,
  isMainWorktree: false
}

describe('collapsePathEqualWorktreeRows', () => {
  it('keeps the spelling that owns metadata and fills its branch from the peer', () => {
    const rows = collapsePathEqualWorktreeRows(
      repo,
      [main, onBranch, detached],
      (id) => id === 'repo::/x//task'
    )
    expect(rows).toEqual([main, { ...onBranch, path: '/x//task' }])
  })

  it("keeps Git's first spelling when both own metadata", () => {
    expect(collapsePathEqualWorktreeRows(repo, [main, onBranch, detached], () => true)).toEqual([
      main,
      onBranch
    ])
  })
})
