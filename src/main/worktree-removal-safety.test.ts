import { describe, expect, it } from 'vitest'
import type { GitWorktreeInfo } from '../shared/types'
import { getRegisteredDeletableWorktree, isWorktreePathMissing } from './worktree-removal-safety'

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

describe('isWorktreePathMissing', () => {
  it('recognizes missing-path errors from local and remote stat providers', async () => {
    await expect(
      isWorktreePathMissing('/missing', async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      })
    ).resolves.toBe(true)

    await expect(
      isWorktreePathMissing('/missing', () => Promise.reject({ code: 'ENOTDIR' }))
    ).resolves.toBe(true)
  })

  it('does not classify existing paths or unrelated stat failures as missing', async () => {
    await expect(isWorktreePathMissing('/exists', async () => ({}))).resolves.toBe(false)

    await expect(
      isWorktreePathMissing('/unknown', async () => {
        throw new Error('permission denied')
      })
    ).resolves.toBe(false)
  })
})
