import { win32 } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getWslHomeMock, parseWslPathMock } = vi.hoisted(() => ({
  getWslHomeMock: vi.fn(),
  parseWslPathMock: vi.fn()
}))

vi.mock('../wsl', () => ({
  getWslHome: getWslHomeMock,
  parseWslPath: parseWslPathMock
}))

import { computeWorktreePath } from './worktree-logic'

describe('computeWorktreePath WSL layout', () => {
  beforeEach(() => {
    getWslHomeMock.mockReset()
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
        workspaceDir: 'C:\\workspaces',
        worktreeLocation: 'external'
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
        workspaceDir: 'C:\\workspaces',
        worktreeLocation: 'external'
      })
    ).toBe(win32.join('C:\\workspaces', 'feature'))
  })

  it('in-repo mode places WSL repo worktrees under the repo directory, skipping the WSL workspace override', () => {
    // The mocks below are intentionally NOT called by computeWorktreePath when
    // worktreeLocation is 'in-repo' — the in-repo branch runs first and uses
    // win32 path operations directly on the repo path. We assert this by
    // verifying both mocks have zero calls at the end of the test. Setting
    // the return values is defensive: if a future refactor accidentally
    // routes the in-repo branch through parseWslPath/getWslHome, the mocks
    // will return plausible values instead of returning undefined.
    parseWslPathMock.mockReturnValue({
      distro: 'Ubuntu',
      linuxPath: '/home/jin/src/repo'
    })
    getWslHomeMock.mockReturnValue('\\\\wsl.localhost\\Ubuntu\\home\\jin')

    expect(
      computeWorktreePath('feature', '\\\\wsl.localhost\\Ubuntu\\home\\jin\\src\\repo', {
        nestWorkspaces: true,
        workspaceDir: 'C:\\workspaces',
        worktreeLocation: 'in-repo'
      })
    ).toBe('\\\\wsl.localhost\\Ubuntu\\home\\jin\\src\\repo\\.worktrees\\feature')

    // Lock in that the in-repo branch never touched the WSL helpers.
    expect(parseWslPathMock).not.toHaveBeenCalled()
    expect(getWslHomeMock).not.toHaveBeenCalled()
  })
})
