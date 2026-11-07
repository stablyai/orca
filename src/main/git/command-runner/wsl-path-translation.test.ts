import { afterEach, describe, expect, it } from 'vitest'
import { translateWslOutputPaths } from './wsl-path-translation'

const originalPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})

describe('translateWslOutputPaths', () => {
  it('keeps drvfs worktrees of a repo inside the distro on the distro UNC path', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    expect(
      translateWslOutputPaths(
        'worktree /home/me/repo\nworktree /mnt/c/Projects/repo-content\n',
        '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
      )
    ).toBe(
      'worktree \\\\wsl.localhost\\Ubuntu\\home\\me\\repo\n' +
        'worktree \\\\wsl.localhost\\Ubuntu\\mnt\\c\\Projects\\repo-content\n'
    )
  })
})
