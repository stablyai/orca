import { describe, expect, it } from 'vitest'
import {
  getWindowsCmdPath,
  resolveWindowsPowerShellExecutablePath,
  resolveWindowsPowerShellSpawnChain
} from './windows-powershell-executable'

const WIN_ENV: NodeJS.ProcessEnv = {
  ProgramW6432: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
  SystemRoot: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe'
}

const PWSH7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const PATH_PWSH7 = 'D:\\Tools\\PowerShell\\7\\pwsh.exe'
const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
// The Microsoft Store App Execution Alias stub for pwsh — a zero-byte reparse
// point under WindowsApps that ConPTY's CreateProcessW rejects with error 5.
const PWSH_STORE_ALIAS = 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'
const PWSH_STORE_EXE =
  'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.3.0_x64__8wekyb3d8bbwe\\pwsh.exe'

describe('resolveWindowsPowerShellExecutablePath', () => {
  it('returns null on non-Windows platforms', () => {
    expect(
      resolveWindowsPowerShellExecutablePath('pwsh.exe', {
        platform: 'linux',
        env: WIN_ENV,
        isRealExecutable: () => true
      })
    ).toBeNull()
  })

  it('resolves pwsh.exe to a real absolute path under Program Files', () => {
    expect(
      resolveWindowsPowerShellExecutablePath('pwsh.exe', {
        platform: 'win32',
        env: WIN_ENV,
        isRealExecutable: (p) => p === PWSH7
      })
    ).toBe(PWSH7)
  })

  it('repro: resolves pwsh.exe from a real PATH entry when standard roots miss', () => {
    expect(
      resolveWindowsPowerShellExecutablePath('pwsh.exe', {
        platform: 'win32',
        env: {
          ...WIN_ENV,
          Path: [
            'relative-tools',
            'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps',
            'D:\\Tools\\PowerShell\\7'
          ].join(';')
        },
        isRealExecutable: (p) => p === PATH_PWSH7
      })
    ).toBe(PATH_PWSH7)
  })

  it('resolves powershell.exe to inbox System32 WindowsPowerShell', () => {
    expect(
      resolveWindowsPowerShellExecutablePath('powershell.exe', {
        platform: 'win32',
        env: WIN_ENV,
        isRealExecutable: (p) => p === WINDOWS_POWERSHELL
      })
    ).toBe(WINDOWS_POWERSHELL)
  })

  it('repro: never resolves pwsh.exe to the Store App Execution Alias stub', () => {
    // Only the WindowsApps alias "exists"; a naive resolver would return it and
    // ConPTY would fail with error code 5. The resolver must reject it.
    const resolved = resolveWindowsPowerShellExecutablePath('pwsh.exe', {
      platform: 'win32',
      env: WIN_ENV,
      isRealExecutable: (p) => p === PWSH_STORE_ALIAS
    })
    expect(resolved).toBeNull()
    expect(resolved).not.toBe(PWSH_STORE_ALIAS)
  })

  it('repro: resolves a Store App Execution Alias to its real package executable', () => {
    const resolved = resolveWindowsPowerShellExecutablePath('pwsh.exe', {
      platform: 'win32',
      env: {
        ...WIN_ENV,
        Path: 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps'
      },
      isRealExecutable: (p) => p === PWSH_STORE_EXE,
      resolveAppExecutionAlias: (p) => (p === PWSH_STORE_ALIAS ? PWSH_STORE_EXE : null)
    })
    expect(resolved).toBe(PWSH_STORE_EXE)
  })

  it.each(['pwsh.exe', PWSH_STORE_ALIAS, 'C:\\Tools\\powershell.exe'])(
    'rejects unsafe Store alias target %s',
    (target) => {
      const resolved = resolveWindowsPowerShellExecutablePath('pwsh.exe', {
        platform: 'win32',
        env: {
          ...WIN_ENV,
          Path: 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps'
        },
        isRealExecutable: (p) => p === target,
        resolveAppExecutionAlias: (p) => (p === PWSH_STORE_ALIAS ? target : null)
      })
      expect(resolved).toBeNull()
    }
  )

  it('returns null for pwsh when no real executable is found', () => {
    expect(
      resolveWindowsPowerShellExecutablePath('pwsh.exe', {
        platform: 'win32',
        env: WIN_ENV,
        isRealExecutable: () => false
      })
    ).toBeNull()
  })
})

describe('resolveWindowsPowerShellSpawnChain', () => {
  it('orders pwsh -> Windows PowerShell -> cmd.exe when all resolve', () => {
    const chain = resolveWindowsPowerShellSpawnChain('pwsh.exe', {
      platform: 'win32',
      env: WIN_ENV,
      isRealExecutable: (p) => p === PWSH7 || p === WINDOWS_POWERSHELL
    })
    expect(chain).toEqual([PWSH7, WINDOWS_POWERSHELL, WIN_ENV.ComSpec])
  })

  it('falls back to Windows PowerShell + cmd.exe when pwsh is only a Store alias', () => {
    const chain = resolveWindowsPowerShellSpawnChain('pwsh.exe', {
      platform: 'win32',
      env: WIN_ENV,
      // pwsh exists only as the alias stub (rejected); Windows PowerShell is real.
      isRealExecutable: (p) => p === PWSH_STORE_ALIAS || p === WINDOWS_POWERSHELL
    })
    expect(chain).toEqual([WINDOWS_POWERSHELL, WIN_ENV.ComSpec])
    expect(chain).not.toContain(PWSH_STORE_ALIAS)
  })

  it('uses the real Store package executable ahead of Windows PowerShell', () => {
    const chain = resolveWindowsPowerShellSpawnChain('pwsh.exe', {
      platform: 'win32',
      env: {
        ...WIN_ENV,
        Path: 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps'
      },
      isRealExecutable: (p) => p === PWSH_STORE_EXE || p === WINDOWS_POWERSHELL,
      resolveAppExecutionAlias: (p) => (p === PWSH_STORE_ALIAS ? PWSH_STORE_EXE : null)
    })
    expect(chain).toEqual([PWSH_STORE_EXE, WINDOWS_POWERSHELL, WIN_ENV.ComSpec])
  })

  it('orders PATH-resolved pwsh before Windows PowerShell when standard roots miss', () => {
    const chain = resolveWindowsPowerShellSpawnChain('pwsh.exe', {
      platform: 'win32',
      env: {
        ...WIN_ENV,
        Path: 'D:\\Tools\\PowerShell\\7'
      },
      isRealExecutable: (p) => p === PATH_PWSH7 || p === WINDOWS_POWERSHELL
    })
    expect(chain).toEqual([PATH_PWSH7, WINDOWS_POWERSHELL, WIN_ENV.ComSpec])
  })

  it('always ends with cmd.exe even when no PowerShell resolves', () => {
    const chain = resolveWindowsPowerShellSpawnChain('powershell.exe', {
      platform: 'win32',
      env: WIN_ENV,
      isRealExecutable: () => false
    })
    expect(chain).toEqual([WIN_ENV.ComSpec])
  })

  it('does not duplicate cmd.exe when ComSpec is missing', () => {
    const chain = resolveWindowsPowerShellSpawnChain('powershell.exe', {
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      isRealExecutable: () => false
    })
    expect(chain).toEqual(['C:\\Windows\\System32\\cmd.exe'])
  })
})

describe('getWindowsCmdPath', () => {
  it('prefers ComSpec when set', () => {
    expect(getWindowsCmdPath(WIN_ENV)).toBe('C:\\Windows\\System32\\cmd.exe')
  })

  it('derives cmd.exe from SystemRoot when ComSpec is absent', () => {
    expect(getWindowsCmdPath({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\cmd.exe')
  })
})
