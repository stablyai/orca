import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings, Repo } from '../../shared/types'
import {
  buildWorktreeBaseDirectoryWatchTargets,
  clearWorktreeBaseDirectoryWatchTargetWarnings
} from './worktree-base-directory-watch-targets'
import { WORKTREE_POLLING_MAX_REPO_CONFIGS } from './worktree-polling-scan-budget'

const settings = {
  workspaceDir: '/worktrees',
  nestWorkspaces: false
} as GlobalSettings

function folderRepo(index: number): Repo {
  return {
    id: `repo-${index}`,
    path: `/repos/${index}`,
    displayName: `Repo ${index}`,
    badgeColor: '#000000',
    addedAt: index,
    kind: 'folder'
  }
}

describe('worktree watcher target repo bounds', () => {
  afterEach(() => {
    clearWorktreeBaseDirectoryWatchTargetWarnings()
    vi.restoreAllMocks()
  })

  it('accepts the exact repo count before hydrating repos', async () => {
    const repos = Array.from({ length: WORKTREE_POLLING_MAX_REPO_CONFIGS }, (_, index) =>
      folderRepo(index)
    )
    const getRepos = vi.fn(() => repos)

    await expect(
      buildWorktreeBaseDirectoryWatchTargets({
        getRepoCount: () => repos.length,
        getRepos,
        getSettings: () => settings
      } as never)
    ).resolves.toEqual(new Map())
    expect(getRepos).toHaveBeenCalledOnce()
  })

  it('rejects one repo over the cap without hydrating the repo array', async () => {
    const getRepos = vi.fn(() => {
      throw new Error('must not hydrate')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      buildWorktreeBaseDirectoryWatchTargets({
        getRepoCount: () => WORKTREE_POLLING_MAX_REPO_CONFIGS + 1,
        getRepos,
        getSettings: () => settings
      } as never)
    ).resolves.toEqual(new Map())
    expect(getRepos).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('resumes target construction after the repo count returns below the cap', async () => {
    let repoCount = WORKTREE_POLLING_MAX_REPO_CONFIGS + 1
    const getRepos = vi.fn(() => [folderRepo(1)])
    const store = {
      getRepoCount: () => repoCount,
      getRepos,
      getSettings: () => settings
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await buildWorktreeBaseDirectoryWatchTargets(store as never)
    expect(getRepos).not.toHaveBeenCalled()

    repoCount = 1
    await buildWorktreeBaseDirectoryWatchTargets(store as never)
    expect(getRepos).toHaveBeenCalledOnce()
  })
})
