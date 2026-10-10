import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../../../persistence/loading-store/store'
import type { Repo } from '../../../../shared/repo-types'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import { warnIfHostsShareGitCommonDir } from './worktree-shared-git-warning'
import { loggedSharedGitCommonDirWarnings } from './worktree-listing-diagnostics'

function createTestRepo(id: string, path: string, connectionId?: string): Repo {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Minimal repo fixture for unit testing.
  return {
    id,
    path,
    displayName: id,
    badgeColor: '#000',
    addedAt: 1,
    ...(connectionId ? { connectionId, executionHostId: `ssh:${connectionId}` } : {})
  } as Repo
}

function createTestSetup(
  id: string,
  projectId: string,
  hostId: string,
  repoId: string,
  path: string
): ProjectHostSetup {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Minimal setup fixture for unit testing.
  return {
    id,
    projectId,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Host ID fixture string for testing.
    hostId: hostId as ProjectHostSetup['hostId'],
    repoId,
    path,
    displayName: id,
    setupState: 'ready',
    setupMethod: 'cloned',
    createdAt: 1,
    updatedAt: 1
  } as ProjectHostSetup
}

function createGitWorktree(path: string, options: Partial<GitWorktreeInfo> = {}): GitWorktreeInfo {
  return {
    path,
    head: '111',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    ...options
  }
}

function createMockStore(setups: ProjectHostSetup[]): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Partial store mock for warning tests.
  return {
    getProjectHostSetups: () => setups
  } as Store
}

describe('warnIfHostsShareGitCommonDir', () => {
  const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

  beforeEach(() => {
    loggedSharedGitCommonDirWarnings.clear()
    consoleWarnSpy.mockClear()
  })

  it('does nothing when project has only one host setup', () => {
    const repo = createTestRepo('repo-1', 'C:/Users/user/project')
    const setups = [createTestSetup('s-1', 'p-1', 'local', 'repo-1', 'C:/Users/user/project')]
    const store = createMockStore(setups)

    warnIfHostsShareGitCommonDir(store, repo, [createGitWorktree('C:/Users/user/project/feat')])

    expect(consoleWarnSpy).not.toHaveBeenCalled()
  })

  it('warns when Windows host encounters Linux worktree belonging to sibling Linux setup', () => {
    const windowsRepo = createTestRepo('repo-win', 'C:/Users/user/project')
    const setups = [
      createTestSetup('s-win', 'p-1', 'local', 'repo-win', 'C:/Users/user/project'),
      createTestSetup('s-linux', 'p-1', 'ssh:dev-container', 'repo-linux', '/workspaces/project')
    ]
    const store = createMockStore(setups)

    const worktrees: GitWorktreeInfo[] = [
      createGitWorktree('C:/Users/user/project/feat'),
      createGitWorktree('/workspaces/project/seacucumber', { prunable: true })
    ]

    warnIfHostsShareGitCommonDir(store, windowsRepo, worktrees)

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "these hosts share one .git; git worktree prune on either host will drop the other's worktrees"
      )
    )
  })

  it('warns when Linux host encounters Windows worktree joined onto admin dir', () => {
    const linuxRepo = createTestRepo('repo-linux', '/workspaces/project', 'dev-container')
    const setups = [
      createTestSetup('s-win', 'p-1', 'local', 'repo-win', 'C:/Users/user/project'),
      createTestSetup('s-linux', 'p-1', 'ssh:dev-container', 'repo-linux', '/workspaces/project')
    ]
    const store = createMockStore(setups)

    const worktrees: GitWorktreeInfo[] = [
      createGitWorktree(
        '/workspaces/project/.git/worktrees/28712-abc/C:/Users/user/project/sockeye',
        {
          prunable: true
        }
      )
    ]

    warnIfHostsShareGitCommonDir(store, linuxRepo, worktrees)

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "these hosts share one .git; git worktree prune on either host will drop the other's worktrees"
      )
    )
  })

  it('does not warn for two hosts that each hold their own clone at the same path', () => {
    const remoteRepo = createTestRepo('repo-b', '/home/dev/project', 'box-b')
    const setups = [
      createTestSetup('s-a', 'p-1', 'ssh:box-a', 'repo-a', '/home/dev/project'),
      createTestSetup('s-b', 'p-1', 'ssh:box-b', 'repo-b', '/home/dev/project')
    ]

    warnIfHostsShareGitCommonDir(createMockStore(setups), remoteRepo, [
      createGitWorktree('/home/dev/project', { isMainWorktree: true }),
      createGitWorktree('/home/dev/project-wt/feat', { prunable: true })
    ])

    expect(consoleWarnSpy).not.toHaveBeenCalled()
  })

  it('names every sibling that could have written the registration as a candidate', () => {
    const windowsRepo = createTestRepo('repo-win', 'C:/Users/user/project')
    const setups = [
      createTestSetup('s-win', 'p-1', 'local', 'repo-win', 'C:/Users/user/project'),
      createTestSetup('s-linux', 'p-1', 'ssh:dev-container', 'repo-linux', '/workspaces/project'),
      createTestSetup('s-mac', 'p-1', 'ssh:mac', 'repo-mac', '/Users/dev/project')
    ]

    warnIfHostsShareGitCommonDir(createMockStore(setups), windowsRepo, [
      createGitWorktree('/workspaces/project/seacucumber', { prunable: true })
    ])

    expect(consoleWarnSpy).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('(local and one of ssh:dev-container, ssh:mac)')
    )
  })

  it('emits one warning when both sides of one shared .git are scanned', () => {
    const setups = [
      createTestSetup('s-win', 'p-1', 'local', 'repo-win', 'C:/Users/user/project'),
      createTestSetup('s-linux', 'p-1', 'ssh:dev-container', 'repo-linux', '/workspaces/project')
    ]
    const store = createMockStore(setups)

    warnIfHostsShareGitCommonDir(store, createTestRepo('repo-win', 'C:/Users/user/project'), [
      createGitWorktree('/workspaces/project/seacucumber', { prunable: true })
    ])
    warnIfHostsShareGitCommonDir(
      store,
      createTestRepo('repo-linux', '/workspaces/project', 'dev-container'),
      [createGitWorktree('/workspaces/project/.git/worktrees/x/C:/Users/user/project/sockeye')]
    )

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
  })

  it('emits one warning across both scan directions with three hosts', () => {
    const setups = [
      createTestSetup('s-win', 'p-1', 'local', 'repo-win', 'C:/Users/user/project'),
      createTestSetup('s-linux', 'p-1', 'ssh:dev-container', 'repo-linux', '/workspaces/project'),
      createTestSetup('s-mac', 'p-1', 'ssh:mac', 'repo-mac', '/Users/dev/project')
    ]
    const store = createMockStore(setups)

    warnIfHostsShareGitCommonDir(store, createTestRepo('repo-win', 'C:/Users/user/project'), [
      createGitWorktree('/workspaces/project/seacucumber', { prunable: true })
    ])
    warnIfHostsShareGitCommonDir(
      store,
      createTestRepo('repo-linux', '/workspaces/project', 'dev-container'),
      [createGitWorktree('/workspaces/project/.git/worktrees/x/C:/Users/user/project/sockeye')]
    )

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
  })

  it('deduplicates warnings for the same project host pair', () => {
    const windowsRepo = createTestRepo('repo-win', 'C:/Users/user/project')
    const setups = [
      createTestSetup('s-win', 'p-1', 'local', 'repo-win', 'C:/Users/user/project'),
      createTestSetup('s-linux', 'p-1', 'ssh:dev-container', 'repo-linux', '/workspaces/project')
    ]
    const store = createMockStore(setups)

    const worktrees: GitWorktreeInfo[] = [
      createGitWorktree('/workspaces/project/seacucumber', { prunable: true })
    ]

    warnIfHostsShareGitCommonDir(store, windowsRepo, worktrees)
    warnIfHostsShareGitCommonDir(store, windowsRepo, worktrees)

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
  })
})
