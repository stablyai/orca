import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import { getRemoteRetirementNamespaceKey } from '../../../workspaces/removal/retirement/worktree-name-retirement'
import type { WorktreePathSettings } from './worktree-path-settings'
import { getWorktreePathSettings, sanitizeWorktreeName } from './worktree-logic'
import { sanitizeWorktreeDisplayName } from '../creation/worktree-display-name'
import { areWorktreePathsEqual } from '../../../git/worktrees/catalog/worktree-path-comparison'

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

describe('areWorktreePathsEqual', () => {
  it('keeps WSL-owned POSIX paths case-sensitive on Windows', () => {
    expect(areWorktreePathsEqual('/home/dev/Repo', '/home/dev/repo', 'win32')).toBe(false)
  })
})

describe('host Workspace Directory', () => {
  const hostId = 'ssh:mini' as const
  const repo = {
    path: '/home/me/milvus',
    connectionId: 'mini',
    executionHostId: hostId
  }
  const settings = {
    nestWorkspaces: false,
    workspaceDir: '/Users/me/.orca/workspaces',
    hostSettingOverrides: {
      [hostId]: { defaultWorktreeLocation: '/home/me/.orca/workspaces' }
    }
  } as WorktreePathSettings

  it('resolves a remote project to the host directory instead of the client default', () => {
    expect(getWorktreePathSettings(repo, settings).workspaceDir).toBe('/home/me/.orca/workspaces')
  })

  it('keeps a per-project Worktree Location ahead of the host directory', () => {
    expect(
      getWorktreePathSettings({ ...repo, worktreeBasePath: '/srv/custom' }, settings).workspaceDir
    ).toBe('/srv/custom')
  })

  it('names remote retirement probes under the host directory', () => {
    expect(getRemoteRetirementNamespaceKey(repo as Repo, settings)).toContain(
      '/home/me/.orca/workspaces/orca-retirement-probe'
    )
  })
})
