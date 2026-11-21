import { describe, expect, it } from 'vitest'
import { getWorktreeCreationLayout, sanitizeWorktreeName } from './worktree-logic'
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

describe('host workspace directory', () => {
  const clientDefault = '/home/dev/orca/workspaces'

  it('uses the host override instead of the client default', () => {
    expect(
      getWorktreeCreationLayout(
        { path: '/srv/app', executionHostId: 'runtime:docker' },
        {
          nestWorkspaces: true,
          workspaceDir: clientDefault,
          hostSettingOverrides: {
            'runtime:docker': { defaultWorktreeLocation: '/workspaces' }
          }
        }
      ).path
    ).toBe('/workspaces')
  })

  it('keeps a repo-specific base ahead of the host override', () => {
    expect(
      getWorktreeCreationLayout(
        {
          path: '/srv/app',
          executionHostId: 'runtime:docker',
          worktreeBasePath: '/repo-base'
        },
        {
          nestWorkspaces: true,
          workspaceDir: clientDefault,
          hostSettingOverrides: {
            'runtime:docker': { defaultWorktreeLocation: '/workspaces' }
          }
        }
      ).path
    ).toBe('/repo-base')
  })
})
