import { describe, expect, it } from 'vitest'
import { resolveDefaultCwd, resolveWindowsDefaultShell } from './pty-shell-utils'

describe('resolveWindowsDefaultShell', () => {
  it('uses an existing SHELL override when one is provided', () => {
    expect(
      resolveWindowsDefaultShell(
        {
          SHELL: 'C:\\Tools\\pwsh.exe',
          SystemRoot: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe'
        },
        (path) => path === 'C:\\Tools\\pwsh.exe'
      )
    ).toBe('C:\\Tools\\pwsh.exe')
  })

  it('prefers inbox PowerShell before ComSpec for an interactive Windows PTY', () => {
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

    expect(
      resolveWindowsDefaultShell(
        {
          SystemRoot: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe'
        },
        (path) => path === powershell || path === 'C:\\Windows\\System32\\cmd.exe'
      )
    ).toBe(powershell)
  })

  it('falls back to ComSpec when PowerShell cannot be found by path', () => {
    expect(
      resolveWindowsDefaultShell(
        {
          SystemRoot: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe'
        },
        (path) => path === 'C:\\Windows\\System32\\cmd.exe'
      )
    ).toBe('C:\\Windows\\System32\\cmd.exe')
  })
})

describe('resolveDefaultCwd', () => {
  it('uses USERPROFILE for Windows PTYs without an explicit cwd', () => {
    expect(
      resolveDefaultCwd(
        {
          USERPROFILE: 'C:\\Users\\alice',
          HOME: '/not/a/windows/cwd'
        },
        'win32',
        'C:\\Users\\fallback'
      )
    ).toBe('C:\\Users\\alice')
  })

  it('falls back to HOMEDRIVE plus HOMEPATH on Windows when USERPROFILE is missing', () => {
    expect(
      resolveDefaultCwd(
        {
          HOMEDRIVE: 'D:',
          HOMEPATH: '\\Users\\bob'
        },
        'win32',
        'C:\\Users\\fallback'
      )
    ).toBe('D:\\Users\\bob')
  })

  it('keeps POSIX HOME fallback behavior', () => {
    expect(resolveDefaultCwd({ HOME: '/home/alice' }, 'linux', '/fallback')).toBe('/home/alice')
  })
})
