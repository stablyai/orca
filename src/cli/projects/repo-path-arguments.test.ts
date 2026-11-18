import { afterEach, describe, expect, it } from 'vitest'
import { resolveRepoPathArgument } from './repo-path-arguments'

describe('resolveRepoPathArgument from a legacy WSL shell', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const originalDistro = process.env.ORCA_CLI_WSL_DISTRO

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    if (originalDistro === undefined) {
      delete process.env.ORCA_CLI_WSL_DISTRO
    } else {
      process.env.ORCA_CLI_WSL_DISTRO = originalDistro
    }
  })

  it('reads a Linux absolute path as a distro file when cwd is a /mnt drive', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.ORCA_CLI_WSL_DISTRO = 'Ubuntu'

    expect(resolveRepoPathArgument('/home/me/../me/shot.png', 'C:\\src\\app', false)).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\shot.png'
    )
  })

  it('reads a /mnt drive path as the Windows drive path', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.ORCA_CLI_WSL_DISTRO = 'Ubuntu'

    expect(
      resolveRepoPathArgument('/mnt/c/Users/me/shot.png', '\\\\wsl$\\Ubuntu\\home', false)
    ).toBe('C:\\Users\\me\\shot.png')
  })
})
