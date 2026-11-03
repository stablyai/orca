import { win32 } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getWslHomeMock, getWslHomeAsyncMock, parseWslPathMock } = vi.hoisted(() => ({
  getWslHomeMock: vi.fn(),
  getWslHomeAsyncMock: vi.fn(),
  parseWslPathMock: vi.fn()
}))

vi.mock('../wsl', () => ({
  getWslHome: getWslHomeMock,
  getWslHomeAsync: getWslHomeAsyncMock,
  parseWslPath: parseWslPathMock
}))

import {
  computeWorktreePath,
  computeWorktreePathAsync,
  computeWorkspaceRootAsync,
  computeWorkspaceRootWithin,
  getWorktreePathSettings
} from './worktree-logic'
import {
  buildKnownOrcaWorkspaceLayouts,
  classifyWorktreeOwnership
} from '../../shared/worktree/ownership'
import { relativePathInsideRoot } from '../../shared/cross-platform-path'
import type { Repo } from '../../shared/repo-types'

describe('computeWorktreePath WSL layout', () => {
  beforeEach(() => {
    getWslHomeMock.mockReset()
    getWslHomeAsyncMock.mockReset()
    parseWslPathMock.mockReset()
  })

  it('reuses an asynchronously resolved root for every name candidate without a sync probe', async () => {
    parseWslPathMock.mockReturnValue({ distro: 'Ubuntu', linuxPath: '/home/jin/repo' })
    const repoPath = String.raw`\\wsl.localhost\Ubuntu\home\jin\repo`
    const home = String.raw`\\wsl.localhost\Ubuntu\home\jin`
    const settings = { workspaceDir: 'C:\\workspaces', nestWorkspaces: true }
    let resolveHome!: (home: string) => void
    getWslHomeAsyncMock.mockReturnValue(new Promise<string>((resolve) => (resolveHome = resolve)))
    const pendingRoot = computeWorkspaceRootAsync(repoPath, settings)
    expect(getWslHomeMock).not.toHaveBeenCalled()
    resolveHome(home)
    const root = await pendingRoot
    for (const name of ['feature', 'feature-2', 'feature-3']) {
      expect(computeWorktreePath(name, repoPath, settings, root)).toBe(
        win32.join(home, 'orca', 'workspaces', 'repo', name)
      )
    }
    expect(getWslHomeAsyncMock).toHaveBeenCalledExactlyOnceWith('Ubuntu')
    expect(getWslHomeMock).not.toHaveBeenCalled()
  })

  it('stops waiting for a WSL home at the deadline and falls back, leaving the probe running', async () => {
    vi.useFakeTimers()
    try {
      parseWslPathMock.mockReturnValue({ distro: 'Ubuntu', linuxPath: '/home/jin/repo' })
      const repoPath = String.raw`\\wsl.localhost\Ubuntu\home\jin\repo`
      const settings = { workspaceDir: 'C:\\workspaces', nestWorkspaces: true }
      getWslHomeAsyncMock.mockReturnValue(new Promise<string>(() => {}))
      const pending = computeWorkspaceRootWithin(repoPath, settings, 5_000)
      await vi.advanceTimersByTimeAsync(5_000)
      const fallback = await pending
      expect(fallback).not.toContain('orca')
      expect(getWslHomeMock).not.toHaveBeenCalled()

      getWslHomeAsyncMock.mockResolvedValue(String.raw`\\wsl.localhost\Ubuntu\home\jin`)
      expect(await computeWorkspaceRootWithin(repoPath, settings, 5_000)).toBe(
        win32.join(String.raw`\\wsl.localhost\Ubuntu\home\jin`, 'orca', 'workspaces')
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads the home through the lookup its main-side caller injects', async () => {
    parseWslPathMock.mockReturnValue({ distro: 'Ubuntu', linuxPath: '/home/jin/repo' })
    const readHome = vi.fn(async () => null)
    const root = await computeWorkspaceRootWithin(
      String.raw`\\wsl.localhost\Ubuntu\home\jin\repo`,
      { workspaceDir: 'C:\\workspaces' },
      5_000,
      readHome
    )
    expect(root).not.toContain('orca')
    expect(readHome).toHaveBeenCalledExactlyOnceWith('Ubuntu')
    expect(getWslHomeAsyncMock).not.toHaveBeenCalled()
  })

  it('places WSL repo worktrees under the distro home workspace root', () => {
    parseWslPathMock.mockReturnValue({
      distro: 'Ubuntu',
      linuxPath: '/home/jin/src/repo'
    })
    getWslHomeMock.mockReturnValue('\\\\wsl.localhost\\Ubuntu\\home\\jin')

    expect(
      computeWorktreePath('feature', '\\\\wsl.localhost\\Ubuntu\\home\\jin\\src\\repo', {
        nestWorkspaces: true,
        workspaceDir: 'C:\\workspaces'
      })
    ).toBe('\\\\wsl.localhost\\Ubuntu\\home\\jin\\orca\\workspaces\\repo\\feature')
  })

  it('falls back to the configured Windows workspace when WSL home lookup fails', () => {
    parseWslPathMock.mockReturnValue({
      distro: 'Ubuntu',
      linuxPath: '/home/jin/src/repo'
    })
    getWslHomeMock.mockReturnValue(null)

    expect(
      computeWorktreePath('feature', '\\\\wsl.localhost\\Ubuntu\\home\\jin\\src\\repo', {
        nestWorkspaces: false,
        workspaceDir: 'C:\\workspaces'
      })
    ).toBe(win32.join('C:\\workspaces', 'feature'))
  })

  it('honors an absolute Linux repo worktree base path inside the repo distro (STA-4772)', () => {
    parseWslPathMock.mockReturnValue({
      distro: 'Ubuntu',
      linuxPath: '/home/jin/src/repo'
    })
    getWslHomeMock.mockReturnValue('\\\\wsl.localhost\\Ubuntu\\home\\jin')
    const repo = {
      path: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\src\\repo',
      worktreeBasePath: '/home/jin/src/.orca-worktrees'
    }
    const settings = { nestWorkspaces: false, workspaceDir: 'C:\\workspaces' }

    expect(computeWorktreePath('feature', repo.path, getWorktreePathSettings(repo, settings))).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\jin\\src\\.orca-worktrees\\feature'
    )
    expect(computeWorktreePath('feature', repo.path, getWorktreePathSettings(repo, settings))).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\jin\\src\\.orca-worktrees\\feature'
    )
    expect(getWslHomeMock).not.toHaveBeenCalled()
  })

  it('honors a drvfs /mnt repo base path instead of mirroring it away', () => {
    parseWslPathMock.mockReturnValue({
      distro: 'Ubuntu',
      linuxPath: '/home/jin/src/repo'
    })
    getWslHomeMock.mockReturnValue('\\\\wsl.localhost\\Ubuntu\\home\\jin')
    const repo = {
      path: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\src\\repo',
      worktreeBasePath: '/mnt/d/trees'
    }

    expect(
      computeWorktreePath(
        'feature',
        repo.path,
        getWorktreePathSettings(repo, { nestWorkspaces: false, workspaceDir: 'C:\\workspaces' })
      )
    ).toBe('\\\\wsl.localhost\\Ubuntu\\mnt\\d\\trees\\feature')
  })

  it('collapses dotted Linux repo base paths end to end', () => {
    parseWslPathMock.mockReturnValue({
      distro: 'Ubuntu',
      linuxPath: '/home/jin/src/repo'
    })
    getWslHomeMock.mockReturnValue('\\\\wsl.localhost\\Ubuntu\\home\\jin')
    const repo = {
      path: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\src\\repo',
      worktreeBasePath: '/home/jin/src/../trees'
    }

    expect(
      computeWorktreePath(
        'feature',
        repo.path,
        getWorktreePathSettings(repo, { nestWorkspaces: false, workspaceDir: 'C:\\workspaces' })
      )
    ).toBe('\\\\wsl.localhost\\Ubuntu\\home\\jin\\trees\\feature')
  })

  it('still mirrors drive-letter repo base paths into the distro home', () => {
    parseWslPathMock.mockReturnValue({
      distro: 'Ubuntu',
      linuxPath: '/home/jin/src/repo'
    })
    getWslHomeMock.mockReturnValue('\\\\wsl.localhost\\Ubuntu\\home\\jin')
    const repo = {
      path: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\src\\repo',
      worktreeBasePath: 'D:\\trees'
    }

    expect(
      computeWorktreePath(
        'feature',
        repo.path,
        getWorktreePathSettings(repo, { nestWorkspaces: false, workspaceDir: 'C:\\workspaces' })
      )
    ).toBe('\\\\wsl.localhost\\Ubuntu\\home\\jin\\orca\\workspaces\\feature')
  })

  it('classifies whatever creation produces for Linux bases, dotted or not', () => {
    parseWslPathMock.mockReturnValue({
      distro: 'Ubuntu',
      linuxPath: '/home/jin/src/repo'
    })
    getWslHomeMock.mockReturnValue('\\\\wsl.localhost\\Ubuntu\\home\\jin')
    const settings = { nestWorkspaces: true, workspaceDir: 'C:\\workspaces' }
    for (const worktreeBasePath of ['/home/jin/trees', '/home/jin/src/../trees', '/mnt/d/trees']) {
      const repo = {
        id: 'r1',
        path: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\src\\repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        kind: 'git',
        worktreeBasePath
      } as Repo
      // Create and allowed-root resolvers must agree on placement.
      const createdPath = computeWorktreePath(
        'feature',
        repo.path,
        getWorktreePathSettings(repo, settings)
      )
      const layouts = buildKnownOrcaWorkspaceLayouts({ ...settings, workspaceDirHistory: [] }, repo)
      // Ownership alone also accepts mirror layout; require containment in the selected repo-base layout.
      expect(relativePathInsideRoot(layouts[0].path, createdPath)).not.toBeNull()
      expect(
        classifyWorktreeOwnership({
          repo,
          settings: { ...settings, workspaceDirHistory: [] },
          worktree: { path: createdPath, isMainWorktree: false },
          knownOrcaLayouts: layouts
        })
      ).toBe('external')
    }
  })

  it('resolves the Linux repo base path identically through the async twin', async () => {
    parseWslPathMock.mockReturnValue({
      distro: 'Ubuntu',
      linuxPath: '/home/jin/src/repo'
    })
    getWslHomeMock.mockReturnValue('\\\\wsl.localhost\\Ubuntu\\home\\jin')
    getWslHomeAsyncMock.mockResolvedValue('\\\\wsl.localhost\\Ubuntu\\home\\jin')
    const repo = {
      path: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\src\\repo',
      worktreeBasePath: '/home/jin/src/.orca-worktrees'
    }
    const pathSettings = getWorktreePathSettings(repo, {
      nestWorkspaces: false,
      workspaceDir: 'C:\\workspaces'
    })

    await expect(computeWorktreePathAsync('feature', repo.path, pathSettings)).resolves.toBe(
      computeWorktreePath('feature', repo.path, pathSettings)
    )
  })

  it('honors a Linux repo base path even when the distro home lookup fails', () => {
    parseWslPathMock.mockReturnValue({
      distro: 'Ubuntu',
      linuxPath: '/home/jin/src/repo'
    })
    getWslHomeMock.mockReturnValue(null)
    const repo = {
      path: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\src\\repo',
      worktreeBasePath: '/home/jin/trees'
    }

    expect(
      computeWorktreePath(
        'feature',
        repo.path,
        getWorktreePathSettings(repo, { nestWorkspaces: false, workspaceDir: 'C:\\workspaces' })
      )
    ).toBe('\\\\wsl.localhost\\Ubuntu\\home\\jin\\trees\\feature')
  })

  it('keeps relative repo base paths anchored to the WSL repo', () => {
    parseWslPathMock.mockReturnValue({
      distro: 'Ubuntu',
      linuxPath: '/home/jin/src/repo'
    })
    getWslHomeMock.mockReturnValue('\\\\wsl.localhost\\Ubuntu\\home\\jin')
    const repo = {
      path: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\src\\repo',
      worktreeBasePath: '../worktrees'
    }

    expect(
      computeWorktreePath(
        'feature',
        repo.path,
        getWorktreePathSettings(repo, { nestWorkspaces: false, workspaceDir: 'C:\\workspaces' })
      )
    ).toBe('\\\\wsl.localhost\\Ubuntu\\home\\jin\\src\\worktrees\\feature')
  })

  it('uses an explicit WSL UNC workspace root without remapping it', () => {
    parseWslPathMock.mockReturnValue({
      distro: 'Ubuntu',
      linuxPath: '/home/jin/src/repo'
    })
    getWslHomeMock.mockReturnValue('\\\\wsl.localhost\\Ubuntu\\home\\jin')

    expect(
      computeWorktreePath('feature', '\\\\wsl.localhost\\Ubuntu\\home\\jin\\src\\repo', {
        nestWorkspaces: false,
        workspaceDir: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\custom-worktrees'
      })
    ).toBe('\\\\wsl.localhost\\Ubuntu\\home\\jin\\custom-worktrees\\feature')
  })

  // WSL Git stats Windows-drive worktrees through slow 9p; keep the tree on Linux and only Git metadata on Windows.
  describe('Windows-drive repo whose project runs in WSL', () => {
    it('places worktrees inside the distro', () => {
      parseWslPathMock.mockReturnValue(null)
      getWslHomeMock.mockReturnValue('\\\\wsl.localhost\\Ubuntu\\home\\jin')

      expect(
        computeWorktreePath('feature', 'C:\\Users\\jin\\repo', {
          nestWorkspaces: false,
          workspaceDir: 'C:\\workspaces',
          wslMirrorDistro: 'Ubuntu'
        })
      ).toBe('\\\\wsl.localhost\\Ubuntu\\home\\jin\\orca\\workspaces\\feature')
    })

    it('keeps Windows placement when the project has no WSL runtime', () => {
      parseWslPathMock.mockReturnValue(null)

      expect(
        computeWorktreePath('feature', 'C:\\Users\\jin\\repo', {
          nestWorkspaces: false,
          workspaceDir: 'C:\\workspaces'
        })
      ).toBe(win32.join('C:\\workspaces', 'feature'))
      expect(getWslHomeMock).not.toHaveBeenCalled()
    })

    it('falls back to Windows placement when the distro home cannot be resolved', () => {
      parseWslPathMock.mockReturnValue(null)
      getWslHomeMock.mockReturnValue(null)

      expect(
        computeWorktreePath('feature', 'C:\\Users\\jin\\repo', {
          nestWorkspaces: false,
          workspaceDir: 'C:\\workspaces',
          wslMirrorDistro: 'Ubuntu'
        })
      ).toBe(win32.join('C:\\workspaces', 'feature'))
    })

    it('respects an explicit repo-relative workspace dir', () => {
      parseWslPathMock.mockReturnValue(null)

      expect(
        computeWorktreePath('feature', 'C:\\Users\\jin\\repo', {
          nestWorkspaces: false,
          workspaceDir: 'worktrees',
          wslMirrorDistro: 'Ubuntu'
        })
      ).toBe(win32.join('C:\\Users\\jin\\repo', 'worktrees', 'feature'))
      expect(getWslHomeMock).not.toHaveBeenCalled()
    })

    it('ignores a stray mirror distro on a POSIX repo path', () => {
      parseWslPathMock.mockReturnValue(null)

      expect(
        computeWorktreePath('feature', '/Users/jin/repo', {
          nestWorkspaces: false,
          workspaceDir: '/Users/jin/workspaces',
          wslMirrorDistro: 'Ubuntu'
        })
      ).toBe('/Users/jin/workspaces/feature')
      expect(getWslHomeMock).not.toHaveBeenCalled()
    })

    it('mirrors on the async path too', async () => {
      parseWslPathMock.mockReturnValue(null)
      getWslHomeAsyncMock.mockResolvedValue('\\\\wsl.localhost\\Ubuntu\\home\\jin')

      await expect(
        computeWorktreePathAsync('feature', 'C:\\Users\\jin\\repo', {
          nestWorkspaces: false,
          workspaceDir: 'C:\\workspaces',
          wslMirrorDistro: 'Ubuntu'
        })
      ).resolves.toBe('\\\\wsl.localhost\\Ubuntu\\home\\jin\\orca\\workspaces\\feature')
    })
  })
})
