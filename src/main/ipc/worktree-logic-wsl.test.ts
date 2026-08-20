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
    // Why repeat: cached follow-up calls must resolve identically to the first.
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

    // Why: desktop drive roots keep WSL worktrees on the WSL filesystem by design.
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
      // Why: the resolver exists so these two layers agree; assert the
      // invariant directly instead of two hardcoded strings that happen to match.
      const createdPath = computeWorktreePath(
        'feature',
        repo.path,
        getWorktreePathSettings(repo, settings)
      )
      const layouts = buildKnownOrcaWorkspaceLayouts({ ...settings, workspaceDirHistory: [] }, repo)
      // Why containment, not just ownership: a regressed resolver lands in the
      // ~/orca/workspaces mirror layout, which also classifies 'external'.
      // layouts[0] is the repo-base layout — it is always pushed first.
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
})
