import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, execFileSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock
}))

import { resetWindowsProcessRowsSnapshotForTests } from '../main/providers/windows-foreground-process-rows'
import { __setWindowsProcessTreeLoaderForTests } from '../main/windows/windows-process-table'
import { resetProcessTableSnapshotForTests } from '../shared/process-table-snapshot'
import { resolveDefaultCwd, resolveWindowsDefaultShell } from './pty-shell-utils'

beforeEach(() => {
  vi.resetModules()
  execFileMock.mockReset()
  execFileSyncMock.mockReset()
  resetProcessTableSnapshotForTests()
  resetWindowsProcessRowsSnapshotForTests()
  __setWindowsProcessTreeLoaderForTests()
})

describe('resolveWindowsDefaultShell', () => {
  it('uses an existing SHELL override when one is provided', () => {
    expect(
      resolveWindowsDefaultShell(
        {
          SHELL: 'C:\\Tools\\pwsh.exe',
          SystemRoot: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe'
        },
        (path) => path === 'C:\\Tools\\pwsh.exe',
        () => {
          throw new Error('DefaultShell should not be read when SHELL wins')
        }
      )
    ).toBe('C:\\Tools\\pwsh.exe')
  })

  it('uses an existing OpenSSH DefaultShell path', () => {
    const powershell7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

    expect(
      resolveWindowsDefaultShell(
        {
          SystemRoot: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe'
        },
        (path) => path === powershell7,
        () => powershell7
      )
    ).toBe(powershell7)
  })

  it('reads and memoizes the OpenSSH DefaultShell registry value', async () => {
    execFileSyncMock.mockReturnValue(
      [
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\OpenSSH',
        '    DefaultShell    REG_SZ    C:\\Program Files\\PowerShell\\7\\pwsh.exe'
      ].join('\n')
    )

    const { readOpenSshDefaultShell } = await import('./pty-shell-utils')

    expect(readOpenSshDefaultShell()).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    expect(readOpenSshDefaultShell()).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    expect(execFileSyncMock).toHaveBeenCalledTimes(1)
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'reg.exe',
      ['query', 'HKLM\\SOFTWARE\\OpenSSH', '/v', 'DefaultShell'],
      { encoding: 'utf8', timeout: 3000, windowsHide: true }
    )
  })

  it('treats malformed OpenSSH DefaultShell output as empty and preserves the fallback chain', async () => {
    execFileSyncMock.mockReturnValue(
      [
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\OpenSSH',
        '    DefaultShellCommandOption    REG_SZ    /c'
      ].join('\n')
    )

    const { readOpenSshDefaultShell } = await import('./pty-shell-utils')
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

    expect(readOpenSshDefaultShell()).toBe('')
    expect(
      resolveWindowsDefaultShell(
        {
          SystemRoot: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe'
        },
        (path) => path === powershell || path === 'C:\\Windows\\System32\\cmd.exe',
        readOpenSshDefaultShell
      )
    ).toBe(powershell)
  })

  it('treats reg.exe failures as empty and preserves the fallback chain', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('reg.exe failed')
    })

    const { readOpenSshDefaultShell } = await import('./pty-shell-utils')
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

    expect(readOpenSshDefaultShell()).toBe('')
    expect(
      resolveWindowsDefaultShell(
        {
          SystemRoot: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe'
        },
        (path) => path === powershell || path === 'C:\\Windows\\System32\\cmd.exe',
        readOpenSshDefaultShell
      )
    ).toBe(powershell)
  })

  it('preserves the fallback chain for an invalid OpenSSH DefaultShell', () => {
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

    expect(
      resolveWindowsDefaultShell(
        {
          SystemRoot: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe'
        },
        (path) => path === powershell,
        () => 'C:\\missing\\pwsh.exe'
      )
    ).toBe(powershell)
  })

  it('honors a deliberate OpenSSH PowerShell 5.1 DefaultShell value', () => {
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

    expect(
      resolveWindowsDefaultShell(
        {
          SystemRoot: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe'
        },
        (path) => path === powershell,
        () => powershell
      )
    ).toBe(powershell)
  })

  it('prefers inbox PowerShell before ComSpec for an interactive Windows PTY', () => {
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

    expect(
      resolveWindowsDefaultShell(
        {
          SystemRoot: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe'
        },
        (path) => path === powershell || path === 'C:\\Windows\\System32\\cmd.exe',
        () => ''
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
        (path) => path === 'C:\\Windows\\System32\\cmd.exe',
        () => ''
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
