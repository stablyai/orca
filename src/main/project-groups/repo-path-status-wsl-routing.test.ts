import { describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/repo-types'

const { getLocalProjectWorktreeGitOptionsMock, getLocalWorktreePathAccessMock, statPathMock } =
  vi.hoisted(() => ({
    getLocalProjectWorktreeGitOptionsMock: vi.fn(() => ({ wslDistro: 'Ubuntu' })),
    getLocalWorktreePathAccessMock: vi.fn(() => ({ statPath: statPathMock })),
    statPathMock: vi.fn(async () => ({ type: 'directory' }))
  }))

vi.mock('../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: getLocalProjectWorktreeGitOptionsMock
}))

vi.mock('../local-worktree-filesystem', () => ({
  getLocalWorktreePathAccess: getLocalWorktreePathAccessMock
}))

import { getFolderWorkspacePathStatus } from './folder-workspace-path-status'

describe('repo path status WSL routing', () => {
  it('stats a local WSL repo through its selected distro', async () => {
    const repo: Repo = {
      id: 'repo-wsl',
      path: '/home/me/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 1,
      executionHostId: 'local'
    }
    const store = {
      getRepos: () => [repo],
      getProjects: () => [],
      getSettings: () => ({})
    } as unknown as Store

    await expect(
      getFolderWorkspacePathStatus(
        store,
        { scope: 'repo', repoId: repo.id, executionHostId: 'local' } as never,
        { getSshFilesystemProvider: () => undefined }
      )
    ).resolves.toEqual({ path: repo.path, exists: true })
    expect(getLocalProjectWorktreeGitOptionsMock).toHaveBeenCalledWith(store, repo)
    expect(getLocalWorktreePathAccessMock).toHaveBeenCalledWith({ wslDistro: 'Ubuntu' })
    expect(statPathMock).toHaveBeenCalledWith(repo.path)
  })
})
