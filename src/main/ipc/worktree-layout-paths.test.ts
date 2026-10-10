import { posix, win32 } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseWslUncPath } from '../../shared/wsl-paths'

const { getWslHomeMock, getWslHomeAsyncMock } = vi.hoisted(() => ({
  getWslHomeMock: vi.fn(),
  getWslHomeAsyncMock: vi.fn()
}))

// Why: parse UNC paths on every platform so the WSL cases run on macOS/Linux CI too.
vi.mock('../wsl', () => ({
  getWslHome: getWslHomeMock,
  getWslHomeAsync: getWslHomeAsyncMock,
  parseWslPath: (path: string) => parseWslUncPath(path)
}))

import {
  computeRemoteWorktreePath,
  computeWorkspaceRoot,
  computeWorktreePath,
  computeWorktreePathAsync,
  getWorktreeCreationLayout,
  getWorktreePathSettings
} from './worktree-logic'

const WORKSPACES = '/home/dev/orca/workspaces'
const REPO = { path: '/home/dev/src/app' }

function worktreePath(
  repo: { path: string; worktreeBasePath?: string },
  settings: Parameters<typeof getWorktreePathSettings>[1],
  nestedRepoDirName?: string
): string {
  return computeWorktreePath(
    'feature',
    repo.path,
    getWorktreePathSettings(repo, settings, undefined, nestedRepoDirName)
  )
}

describe('worktree layout placement (local)', () => {
  it('keeps the exact nested path for profiles written before worktreeLayout', () => {
    expect(worktreePath(REPO, { workspaceDir: WORKSPACES, nestWorkspaces: true })).toBe(
      posix.join(WORKSPACES, 'app', 'feature')
    )
    expect(worktreePath(REPO, { workspaceDir: WORKSPACES, nestWorkspaces: false })).toBe(
      posix.join(WORKSPACES, 'feature')
    )
  })

  it('lets an explicit layout win over the legacy boolean', () => {
    expect(
      worktreePath(REPO, { workspaceDir: WORKSPACES, nestWorkspaces: true, worktreeLayout: 'flat' })
    ).toBe(posix.join(WORKSPACES, 'feature'))
    expect(
      worktreePath(REPO, {
        workspaceDir: WORKSPACES,
        nestWorkspaces: false,
        worktreeLayout: 'nested'
      })
    ).toBe(posix.join(WORKSPACES, 'app', 'feature'))
  })

  it('places sibling worktrees in <repo>.worktrees beside the repo and ignores workspaceDir', () => {
    const settings = {
      workspaceDir: WORKSPACES,
      nestWorkspaces: true,
      worktreeLayout: 'sibling' as const
    }
    const pathSettings = getWorktreePathSettings(REPO, settings)

    expect(pathSettings).toEqual({ workspaceDir: '../app.worktrees', nestWorkspaces: false })
    expect(computeWorkspaceRoot(REPO.path, pathSettings)).toBe('/home/dev/src/app.worktrees')
    expect(worktreePath(REPO, settings)).toBe('/home/dev/src/app.worktrees/feature')
    expect(worktreePath({ path: '/srv/git/app.git' }, settings)).toBe(
      '/srv/git/app.worktrees/feature'
    )
    expect(getWorktreeCreationLayout(REPO, settings)).toEqual({
      path: '../app.worktrees',
      nestWorkspaces: false
    })
  })

  it('places sibling worktrees beside a Windows repo with Windows separators', () => {
    expect(
      worktreePath(
        { path: 'C:\\src\\app' },
        { workspaceDir: 'C:\\orca\\workspaces', nestWorkspaces: true, worktreeLayout: 'sibling' }
      )
    ).toBe('C:\\src\\app.worktrees\\feature')
  })

  it('lets a project Worktree Location win over every layout', () => {
    const relative = { ...REPO, worktreeBasePath: '../trees' }
    const absolute = { ...REPO, worktreeBasePath: '/fast/trees' }
    const base = { workspaceDir: WORKSPACES, nestWorkspaces: true }

    expect(worktreePath(relative, { ...base, worktreeLayout: 'sibling' })).toBe(
      '/home/dev/src/trees/feature'
    )
    expect(worktreePath(absolute, { ...base, worktreeLayout: 'sibling' })).toBe(
      '/fast/trees/feature'
    )
    expect(worktreePath(absolute, { ...base, worktreeLayout: 'nested' })).toBe(
      '/fast/trees/app/feature'
    )
    expect(worktreePath(absolute, { ...base, worktreeLayout: 'flat' })).toBe('/fast/trees/feature')
  })

  it('nests under the resolved folder only when the layout nests', () => {
    const settings = { workspaceDir: WORKSPACES, nestWorkspaces: true }

    expect(worktreePath(REPO, settings, 'app-globex')).toBe(
      posix.join(WORKSPACES, 'app-globex', 'feature')
    )
    expect(
      getWorktreePathSettings(REPO, { ...settings, worktreeLayout: 'flat' }, undefined, 'app-x')
    ).not.toHaveProperty('nestedRepoDirName')
  })
})

describe('worktree layout placement (SSH)', () => {
  const desktopSettings = { workspaceDir: WORKSPACES, nestWorkspaces: true }

  it('puts sibling worktrees beside the remote repo using remote path ops', () => {
    const repo = { path: '/srv/remote/app' }
    expect(
      computeRemoteWorktreePath(
        'feature',
        repo.path,
        getWorktreePathSettings(repo, { ...desktopSettings, worktreeLayout: 'sibling' })
      )
    ).toBe('/srv/remote/app.worktrees/feature')

    const windowsRepo = { path: 'C:\\Remote\\app' }
    expect(
      computeRemoteWorktreePath(
        'feature',
        windowsRepo.path,
        getWorktreePathSettings(windowsRepo, { ...desktopSettings, worktreeLayout: 'sibling' })
      )
    ).toBe('C:\\Remote\\app.worktrees\\feature')
  })

  it('keeps the repo-qualified fallback for nested and flat with a desktop-absolute root', () => {
    const repo = { path: '/srv/remote/app' }
    for (const worktreeLayout of ['nested', 'flat'] as const) {
      expect(
        computeRemoteWorktreePath(
          'feature',
          repo.path,
          getWorktreePathSettings(repo, { ...desktopSettings, worktreeLayout })
        )
      ).toBe('/srv/remote/app-feature')
    }
  })
})

describe('worktree layout placement (WSL)', () => {
  const repoPath = String.raw`\\wsl.localhost\Ubuntu\home\jin\src\repo`
  const home = String.raw`\\wsl.localhost\Ubuntu\home\jin`

  beforeEach(() => {
    getWslHomeMock.mockReset().mockReturnValue(home)
    getWslHomeAsyncMock.mockReset().mockResolvedValue(home)
  })

  it('keeps sibling worktrees inside the distro without probing the WSL home', async () => {
    const settings = getWorktreePathSettings(
      { path: repoPath },
      { workspaceDir: 'C:\\orca\\workspaces', nestWorkspaces: true, worktreeLayout: 'sibling' }
    )

    expect(computeWorktreePath('feature', repoPath, settings)).toBe(
      String.raw`\\wsl.localhost\Ubuntu\home\jin\src\repo.worktrees\feature`
    )
    await expect(computeWorktreePathAsync('feature', repoPath, settings)).resolves.toBe(
      String.raw`\\wsl.localhost\Ubuntu\home\jin\src\repo.worktrees\feature`
    )
    expect(getWslHomeMock).not.toHaveBeenCalled()
    expect(getWslHomeAsyncMock).not.toHaveBeenCalled()
  })

  it('still mirrors nested worktrees into the distro home', () => {
    const settings = getWorktreePathSettings(
      { path: repoPath },
      { workspaceDir: 'C:\\orca\\workspaces', nestWorkspaces: false, worktreeLayout: 'nested' }
    )

    expect(computeWorktreePath('feature', repoPath, settings)).toBe(
      win32.join(home, 'orca', 'workspaces', 'repo', 'feature')
    )
  })

  it('keeps sibling worktrees beside a Windows-drive repo even when its git runs in WSL', () => {
    const settings = getWorktreePathSettings(
      { path: 'C:\\src\\app' },
      { workspaceDir: 'C:\\orca\\workspaces', nestWorkspaces: true, worktreeLayout: 'sibling' },
      'Ubuntu'
    )

    expect(computeWorktreePath('feature', 'C:\\src\\app', settings)).toBe(
      'C:\\src\\app.worktrees\\feature'
    )
    expect(getWslHomeMock).not.toHaveBeenCalled()
  })
})
