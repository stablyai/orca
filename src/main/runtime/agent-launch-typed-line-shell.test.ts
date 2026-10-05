import { describe, expect, it } from 'vitest'
import {
  launchHostProvesAgentInFront,
  nameLocalTypedLineShell
} from './agent-launch-typed-line-shell'

describe('naming the shell a local launch line is typed into', () => {
  it('takes the request’s shell first, then the setting, then SHELL, as the spawn does', () => {
    const base = { isRemote: false, platform: 'darwin' as const, envShell: '/bin/bash' }
    expect(
      nameLocalTypedLineShell({
        ...base,
        shellOverride: '/opt/homebrew/bin/fish',
        defaultShellSetting: '/bin/zsh'
      })
    ).toBe('fish')
    expect(nameLocalTypedLineShell({ ...base, defaultShellSetting: ' /bin/zsh ' })).toBe('zsh')
    expect(nameLocalTypedLineShell(base)).toBe('bash')
    expect(nameLocalTypedLineShell({ ...base, envShell: '' })).toBe('zsh')
  })

  it('names none for a remote host, whose relay picks its own login shell', () => {
    expect(
      nameLocalTypedLineShell({ isRemote: true, platform: 'darwin', envShell: '/bin/zsh' })
    ).toBeUndefined()
  })

  it('names none on Windows, where the pane may be cmd, PowerShell, Git Bash or WSL', () => {
    expect(
      nameLocalTypedLineShell({ isRemote: false, platform: 'win32', envShell: '/bin/zsh' })
    ).toBeUndefined()
  })
})

describe('whether a launch host can prove its agent is in front before a paste', () => {
  it.each([
    ['a local macOS host', false, 'darwin', 'darwin', true],
    ['a local Linux host', false, 'linux', 'linux', true],
    ['a local Windows host', false, 'win32', 'win32', false],
    // The pane runs in the distro, but the reads run on the Windows host.
    ['a local WSL pane', false, 'linux', 'win32', false],
    ['an SSH Linux host from Windows', true, 'linux', 'win32', true],
    ['an SSH Windows host', true, 'win32', 'darwin', false]
  ] as const)('%s: %s', (_label, isRemote, launchPlatform, hostPlatform, proves) => {
    expect(launchHostProvesAgentInFront({ isRemote, launchPlatform, hostPlatform })).toBe(proves)
  })
})
