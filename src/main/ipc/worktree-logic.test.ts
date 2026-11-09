import { describe, expect, it } from 'vitest'
import {
  computeRemoteWorktreePath,
  computeWorkspaceRoot,
  computeWorktreePath,
  ensurePathWithinWorkspace,
  getWorktreePathSettings,
  sanitizeWorktreeName
} from './worktree-logic'
import { sanitizeWorktreeDisplayName } from './worktree-display-name'
import { areWorktreePathsEqual } from '../git/worktrees/catalog/worktree-path-comparison'
import { buildKnownOrcaWorkspaceLayouts } from '../../shared/worktree/ownership'

describe('sanitizeWorktreeName', () => {
  it('preserves non-ASCII letters and numbers', () => {
    expect(sanitizeWorktreeName('中文')).toBe('中文')
    expect(sanitizeWorktreeName('日本語 テスト')).toBe('日本語-テスト')
    expect(sanitizeWorktreeName('café-déjà')).toBe('café-déjà')
    expect(sanitizeWorktreeName('Привет мир')).toBe('Привет-мир')
  })
})

describe('sanitizeWorktreeDisplayName', () => {
  it('strips bidi override controls from external artifact titles', () => {
    expect(sanitizeWorktreeDisplayName('Review \u202eexe.txt')).toBe('Review exe.txt')
  })
})

describe('ensurePathWithinWorkspace', () => {
  it('throws when path traverses outside workspace', () => {
    expect(() => ensurePathWithinWorkspace('/workspace/../outside', '/workspace')).toThrow(
      'Invalid worktree path'
    )
  })
})

describe('areWorktreePathsEqual', () => {
  it('keeps WSL-owned POSIX paths case-sensitive on Windows', () => {
    expect(areWorktreePathsEqual('/home/dev/Repo', '/home/dev/repo', 'win32')).toBe(false)
  })
})

describe('workspaceDir whitespace trimming (#39545)', () => {
  it('resolves a leading-space POSIX absolute workspaceDir as absolute instead of repo-relative', () => {
    expect(
      computeWorkspaceRoot('/Users/dev/repos/app', {
        workspaceDir: ' /Users/dev/workspaces'
      })
    ).toBe('/Users/dev/workspaces')
    expect(
      computeWorktreePath('feature-branch', '/Users/dev/repos/app', {
        workspaceDir: ' /Users/dev/workspaces ',
        nestWorkspaces: true
      })
    ).toBe('/Users/dev/workspaces/app/feature-branch')
  })

  it('trims settings.workspaceDir in getWorktreePathSettings and computeRemoteWorktreePath', () => {
    const effective = getWorktreePathSettings(
      { path: '/Users/dev/repos/app' },
      { workspaceDir: ' /Users/dev/workspaces ', nestWorkspaces: false }
    )
    expect(effective.workspaceDir).toBe('/Users/dev/workspaces')
    expect(
      computeRemoteWorktreePath('feature-branch', '/home/dev/repos/app', {
        workspaceDir: ' /Users/dev/workspaces',
        nestWorkspaces: false
      })
    ).toBe('/home/dev/repos/app-feature-branch')
  })

  it('preserves both trimmed and legacy untrimmed paths for historical layouts', () => {
    const layouts = buildKnownOrcaWorkspaceLayouts(
      {
        workspaceDir: '/Users/dev/workspaces',
        nestWorkspaces: false,
        workspaceDirHistory: [{ path: ' /Users/dev/legacy-work', nestWorkspaces: false }]
      },
      { path: '/Users/dev/repos/app' }
    )
    expect(layouts.map((layout) => layout.path)).toEqual([
      '/Users/dev/workspaces',
      '/Users/dev/legacy-work',
      '/Users/dev/repos/app/ /Users/dev/legacy-work'
    ])
  })
})
