import { describe, expect, it } from 'vitest'
import type { GitWorktreeInfo } from '../shared/types'
import { getRegisteredDeletableWorktree } from './worktree-removal-safety'

function makeGitWorktree(path: string, isMainWorktree = false): GitWorktreeInfo {
  return {
    path,
    head: 'abc123',
    branch: isMainWorktree ? 'refs/heads/main' : `refs/heads/${path.split('/').at(-1)}`,
    isBare: false,
    isMainWorktree
  }
}

describe('getRegisteredDeletableWorktree', () => {
  it('rejects deleting a worktree that contains another registered worktree', () => {
    expect(() =>
      getRegisteredDeletableWorktree('/repo', '/workspaces/parent', [
        makeGitWorktree('/repo', true),
        makeGitWorktree('/workspaces/parent'),
        makeGitWorktree('/workspaces/parent/child')
      ])
    ).toThrow(
      'Refusing to delete worktree because it contains another registered worktree: /workspaces/parent/child'
    )
  })

  it('does not reject sibling worktree paths that only share a prefix', () => {
    expect(
      getRegisteredDeletableWorktree('/repo', '/workspaces/parent', [
        makeGitWorktree('/repo', true),
        makeGitWorktree('/workspaces/parent'),
        makeGitWorktree('/workspaces/parent-copy')
      ])
    ).toMatchObject({ path: '/workspaces/parent' })
  })
})
