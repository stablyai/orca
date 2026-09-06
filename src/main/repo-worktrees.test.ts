import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { listWorktreeGraphMock, listWorktreesMock, listWorktreesStrictMock } = vi.hoisted(() => ({
  listWorktreeGraphMock: vi.fn(),
  listWorktreesMock: vi.fn(),
  listWorktreesStrictMock: vi.fn()
}))

vi.mock('./git/worktree', () => ({
  listWorktreeGraph: listWorktreeGraphMock,
  listWorktrees: listWorktreesMock,
  listWorktreesStrict: listWorktreesStrictMock
}))

import {
  createFolderWorktree,
  isRepoRoot,
  listLocalRepoWorktreesStrict,
  listRepoWorktreeGraph,
  listRepoWorktrees
} from './repo-worktrees'
import { registerSshGitProvider, unregisterSshGitProvider } from './providers/ssh-git-dispatch'
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

  // Path-only callers must reach the probe-free listing, never the annotated one.
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

  // #11163: a row may spell its owner only as `executionHostId`. Reading `connectionId` answers
  // "local" for it and runs the listing against a same-named path on this machine.
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

    afterEach(() => {
      unregisterSshGitProvider('host-a')
      unregisterSshGitProvider('nested-target')
    })

    it('never lists an ssh-owned row with local git', async () => {
      await expect(listRepoWorktrees(sshOnlyRepo)).rejects.toThrow(WorktreeCatalogUnavailableError)
      expect(listWorktreesMock).not.toHaveBeenCalled()
    })

    it('lists an ssh-owned row through its registered provider', async () => {
      const listWorktrees = vi.fn().mockResolvedValue([{ path: '/srv/repo' }])
      registerSshGitProvider('host-a', { listWorktrees } as never)

      await expect(listRepoWorktrees(sshOnlyRepo)).resolves.toEqual([{ path: '/srv/repo' }])
      expect(listWorktrees).toHaveBeenCalledWith('/srv/repo')
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
      const listWorktrees = vi.fn().mockResolvedValue([{ path: '/wrong/host' }])
      registerSshGitProvider('nested-target', { listWorktrees } as never)

      await expect(
        listRepoWorktrees({
          ...sshOnlyRepo,
          executionHostId: 'runtime:env-7',
          connectionId: 'nested-target'
        })
      ).rejects.toThrow(WorktreeCatalogUnavailableError)
      expect(listWorktrees).not.toHaveBeenCalled()
      expect(listWorktreesMock).not.toHaveBeenCalled()
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
