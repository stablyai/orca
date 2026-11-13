import { describe, expect, it } from 'vitest'
import {
  resolveWindowsPowerShellExecutablePath,
  resolveWindowsPowerShellSpawnChain
} from './powershell-executable'

const WIN_ENV: NodeJS.ProcessEnv = {
  ProgramW6432: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
  SystemRoot: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe'
}

const PATH_PWSH7 = 'D:\\Tools\\PowerShell\\7\\pwsh.exe'
const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
// Store alias reparse points fail ConPTY CreateProcessW with access-denied (5).
const PWSH_STORE_ALIAS = 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'
const PWSH_STORE_EXE =
  'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.3.0_x64__8wekyb3d8bbwe\\pwsh.exe'

describe('resolveWindowsPowerShellExecutablePath', () => {
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

  it('repro: never resolves pwsh.exe to the Store App Execution Alias stub', () => {
    // Alias existence cannot prove a ConPTY-launchable executable.
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
})

describe('resolveWindowsPowerShellSpawnChain', () => {
  it('falls back to Windows PowerShell + cmd.exe when pwsh is only a Store alias', () => {
    const chain = resolveWindowsPowerShellSpawnChain('pwsh.exe', {
      platform: 'win32',
      env: WIN_ENV,
      isRealExecutable: (p) => p === PWSH_STORE_ALIAS || p === WINDOWS_POWERSHELL
    })
    expect(chain).toEqual([WINDOWS_POWERSHELL, WIN_ENV.ComSpec])
    expect(chain).not.toContain(PWSH_STORE_ALIAS)
  })
})
