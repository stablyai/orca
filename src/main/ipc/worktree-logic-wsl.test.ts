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
})
