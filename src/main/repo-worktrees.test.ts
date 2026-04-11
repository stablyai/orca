import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listWorktreesMock } = vi.hoisted(() => ({
  listWorktreesMock: vi.fn()
}))

vi.mock('./git/worktree', () => ({
  listWorktrees: listWorktreesMock
}))

import { createFolderWorktree, listRepoWorktrees } from './repo-worktrees'

describe('repo-worktrees', () => {
  beforeEach(() => {
    listWorktreesMock.mockReset()
  })

  it('creates a stable synthetic worktree for folder repos', () => {
    expect(
      createFolderWorktree({
        id: 'repo-1',
        path: '/workspace/folder',
        displayName: 'folder',
        badgeColor: '#000',
        addedAt: 0,
        kind: 'folder'
      })
    ).toEqual({
      path: '/workspace/folder',
      head: '',
      branch: '',
      isBare: false,
      isMainWorktree: true,
      isPrunable: false
    })
  })

  it('returns the synthetic folder worktree instead of shelling out to git', async () => {
    const result = await listRepoWorktrees({
      id: 'repo-1',
      path: '/workspace/folder',
      displayName: 'folder',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'folder'
    })

    expect(result).toEqual([
      {
        path: '/workspace/folder',
        head: '',
        branch: '',
        isBare: false,
        isMainWorktree: true,
        isPrunable: false
      }
    ])
    expect(listWorktreesMock).not.toHaveBeenCalled()
  })

  it('delegates to git worktree listing for git repos', async () => {
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/repo',
        head: 'abc',
        branch: '',
        isBare: false,
        isMainWorktree: true,
        isPrunable: false
      }
    ])

    const result = await listRepoWorktrees({
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'git'
    })

    expect(listWorktreesMock).toHaveBeenCalledWith('/workspace/repo')
    expect(result).toHaveLength(1)
  })
})
