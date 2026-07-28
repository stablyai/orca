import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/types'

const { listRepoWorktreesMock, getLocalProjectWorktreeGitOptionsMock } = vi.hoisted(() => ({
  listRepoWorktreesMock: vi.fn(),
  getLocalProjectWorktreeGitOptionsMock: vi.fn()
}))

vi.mock('../repo-worktrees', () => ({
  createFolderWorktree: vi.fn(),
  listRepoWorktrees: listRepoWorktreesMock
}))

vi.mock('../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: getLocalProjectWorktreeGitOptionsMock
}))

import { scanWorkspaceCleanup } from './workspace-cleanup-scan'

const REPO: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: 0
}

describe('workspace cleanup local Git routing', () => {
  beforeEach(() => {
    listRepoWorktreesMock.mockReset().mockResolvedValue([])
    getLocalProjectWorktreeGitOptionsMock.mockReset()
  })

  it('uses the selected WSL distro while retaining the cleanup timeout signal', async () => {
    const store = {
      getRepos: () => [REPO]
    } as Store
    getLocalProjectWorktreeGitOptionsMock.mockReturnValue({ wslDistro: 'Ubuntu' })

    await scanWorkspaceCleanup(store)

    expect(getLocalProjectWorktreeGitOptionsMock).toHaveBeenCalledWith(store, REPO)
    expect(listRepoWorktreesMock).toHaveBeenCalledWith(REPO, {
      wslDistro: 'Ubuntu',
      signal: expect.any(AbortSignal)
    })
  })
})
