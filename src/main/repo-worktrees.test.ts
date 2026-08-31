import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listWorktreesMock, listWorktreesStrictMock } = vi.hoisted(() => ({
  listWorktreesMock: vi.fn(),
  listWorktreesStrictMock: vi.fn()
}))

vi.mock('./git/worktree', () => ({
  listWorktrees: listWorktreesMock,
  listWorktreesStrict: listWorktreesStrictMock
}))

import {
  createFolderWorktree,
  isRepoRoot,
  listLocalRepoWorktreesStrict,
  listRepoWorktrees
} from './repo-worktrees'

describe('repo-worktrees', () => {
  beforeEach(() => {
    listWorktreesMock.mockReset()
    listWorktreesStrictMock.mockReset()
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
      isMainWorktree: true
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
        isMainWorktree: true
      }
    ])
    expect(listWorktreesMock).not.toHaveBeenCalled()
  })

  it('returns the synthetic folder worktree for strict local listing', async () => {
    const result = await listLocalRepoWorktreesStrict({
      id: 'repo-1',
      path: '/workspace/folder',
      displayName: 'folder',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'folder'
    })

    expect(result).toEqual([
      createFolderWorktree({
        id: 'repo-1',
        path: '/workspace/folder',
        displayName: 'folder',
        badgeColor: '#000',
        addedAt: 0,
        kind: 'folder'
      })
    ])
    expect(listWorktreesStrictMock).not.toHaveBeenCalled()
  })

  it('delegates to git worktree listing for git repos', async () => {
    listWorktreesMock.mockResolvedValue([
      { path: '/workspace/repo', head: 'abc', branch: '', isBare: false, isMainWorktree: true }
    ])
    const signal = new AbortController().signal

    const result = await listRepoWorktrees(
      {
        id: 'repo-1',
        path: '/workspace/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        kind: 'git'
      },
      { signal }
    )

    expect(listWorktreesMock).toHaveBeenCalledWith('/workspace/repo', { signal })
    expect(result).toHaveLength(1)
  })

  it('delegates strict local listing with the signal and WSL options', async () => {
    listWorktreesStrictMock.mockResolvedValue([
      { path: '/workspace/repo', head: 'abc', branch: '', isBare: false, isMainWorktree: true }
    ])
    const signal = new AbortController().signal

    const result = await listLocalRepoWorktreesStrict(
      {
        id: 'repo-1',
        path: '/workspace/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        kind: 'git'
      },
      { signal, wslDistro: 'Ubuntu' }
    )

    expect(listWorktreesStrictMock).toHaveBeenCalledWith('/workspace/repo', {
      signal,
      wslDistro: 'Ubuntu'
    })
    expect(result).toHaveLength(1)
  })

  it('rejects strict listing for remote repos', async () => {
    await expect(
      listLocalRepoWorktreesStrict({
        id: 'repo-1',
        path: '/workspace/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: 'ssh-1',
        kind: 'git'
      })
    ).rejects.toThrow('remote repository')
    expect(listWorktreesStrictMock).not.toHaveBeenCalled()
  })

  it('treats Windows repo root casing differences as the same local root', () => {
    const repos = [
      {
        id: 'repo-1',
        path: String.raw`C:\Repo`,
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        kind: 'git' as const
      }
    ]

    expect(isRepoRoot(repos, String.raw`c:\repo`)).toBe(true)
  })
})
