import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listWorktreeGraphMock, listWorktreesMock, listWorktreesStrictMock } = vi.hoisted(() => ({
  listWorktreeGraphMock: vi.fn(),
  listWorktreesMock: vi.fn(),
  listWorktreesStrictMock: vi.fn()
}))

vi.mock('./git/worktree', () => ({
  listWorktreeGraph: listWorktreeGraphMock,
  listWorktrees: listWorktreesMock,
  listWorktreesStrict: listWorktreesStrictMock,
  listWorktreesSharedStrictAllowingTrueEmpty: listWorktreesStrictMock
}))

import {
  createFolderWorktree,
  isRepoRoot,
  listLocalRepoWorktreesStrict,
  listRepoWorktreeGraph,
  listRepoWorktrees,
  listRepoWorktreesForDetectedScan
} from './repo-worktrees'
import { WorktreeCatalogUnavailableError } from '../shared/worktree/worktree-catalog-availability'

describe('repo-worktrees', () => {
  beforeEach(() => {
    listWorktreeGraphMock.mockReset()
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

  it('delegates to the graph listing without sparse annotation', async () => {
    listWorktreeGraphMock.mockResolvedValue([
      { path: '/workspace/repo', head: 'abc', branch: '', isBare: false, isMainWorktree: true }
    ])

    const result = await listRepoWorktreeGraph({
      id: 'repo-1',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'git'
    })

    expect(listWorktreeGraphMock).toHaveBeenCalledWith('/workspace/repo')
    expect(listWorktreesMock).not.toHaveBeenCalled()
    expect(result).toHaveLength(1)
  })

  it('returns the synthetic folder worktree from the graph listing', async () => {
    const result = await listRepoWorktreeGraph({
      id: 'repo-1',
      path: '/workspace/folder',
      displayName: 'folder',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'folder'
    })

    expect(listWorktreeGraphMock).not.toHaveBeenCalled()
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

  describe('rows that spell their owner only as executionHostId', () => {
    const sshOnlyRepo = {
      id: 'repo-1',
      path: '/srv/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'git' as const,
      executionHostId: 'ssh:host-a' as const
    }

    it('never lists an ssh-owned row with local git', async () => {
      await expect(listRepoWorktrees(sshOnlyRepo)).rejects.toThrow(WorktreeCatalogUnavailableError)
      expect(listWorktreesMock).not.toHaveBeenCalled()
    })

    it('keeps an ssh-owned root out of the local repo-root match', () => {
      expect(isRepoRoot([sshOnlyRepo], '/srv/repo')).toBe(false)
    })

    it('rejects strict local listing for an ssh-owned row', async () => {
      await expect(listLocalRepoWorktreesStrict(sshOnlyRepo)).rejects.toThrow('remote repository')
      expect(listWorktreesStrictMock).not.toHaveBeenCalled()
    })

    it('refuses to answer a runtime-owned row from a same-named local target', async () => {
      await expect(
        listRepoWorktrees({
          ...sshOnlyRepo,
          executionHostId: 'runtime:env-7',
          connectionId: 'nested-target'
        })
      ).rejects.toThrow(WorktreeCatalogUnavailableError)
      expect(listWorktreesMock).not.toHaveBeenCalled()
    })

    it('reports an unserved ssh host as unavailable from the graph listing, never as empty', async () => {
      await expect(listRepoWorktreeGraph(sshOnlyRepo)).rejects.toThrow(
        'SSH connection "host-a" is not connected'
      )
      await expect(listRepoWorktreeGraph(sshOnlyRepo)).rejects.toBeInstanceOf(
        WorktreeCatalogUnavailableError
      )
      expect(listWorktreeGraphMock).not.toHaveBeenCalled()
    })

    it('reports a runtime-owned row as unavailable from the graph listing, never as empty', async () => {
      await expect(
        listRepoWorktreeGraph({
          ...sshOnlyRepo,
          executionHostId: 'runtime:env-7',
          connectionId: 'nested-target'
        })
      ).rejects.toThrow('host runtime:env-7 is not reachable from this process')
      expect(listWorktreeGraphMock).not.toHaveBeenCalled()
    })
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

it('keeps an upgraded linked folder locator in every local listing, including restart hydration', async () => {
  const repo = {
    id: 'folder',
    path: 'C:\\projects\\draft',
    displayName: 'draft',
    badgeColor: 'blue',
    addedAt: 0,
    kind: 'git' as const,
    folderUpgradeGitRootPath: 'C:/projects/draft'
  }
  const raw = [
    { path: 'C:/projects/main', head: 'abc', branch: 'main', isBare: false, isMainWorktree: true },
    {
      path: 'C:/projects/draft',
      head: 'def',
      branch: 'draft',
      isBare: false,
      isMainWorktree: false
    }
  ]
  listWorktreesMock.mockResolvedValue(raw)
  listWorktreeGraphMock.mockResolvedValue(raw)
  listWorktreesStrictMock.mockResolvedValue(raw)
  for (const list of [
    listRepoWorktrees,
    listRepoWorktreesForDetectedScan,
    listRepoWorktreeGraph,
    listLocalRepoWorktreesStrict
  ]) {
    expect(await list(repo)).toEqual([raw[0], { ...raw[1], path: repo.path }])
  }
  expect(raw[1].path).toBe('C:/projects/draft')
})
