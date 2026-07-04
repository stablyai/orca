import { describe, expect, it } from 'vitest'
import { resolveWindowsPowerShellShellPath } from './windows-powershell-shell'

describe('resolveWindowsPowerShellShellPath', () => {
  it('uses the shared real-executable predicate for absolute shell overrides', () => {
    const pwsh = 'C:\\Tools\\PowerShell\\7\\pwsh.exe'

    expect(
      resolveWindowsPowerShellShellPath(
        pwsh,
        {
          PATH: '',
          SystemRoot: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe'
        },
        { isRealExecutable: (path) => path === pwsh }
      )
    ).toBe(pwsh)
  })

  it('rejects WindowsApps alias stubs even when the predicate returns true', () => {
    const alias = 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

    expect(
      resolveWindowsPowerShellShellPath(
        alias,
        {
          PATH: 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps',
          SystemRoot: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe'
        },
        { isRealExecutable: () => true }
      )
    ).toBe(powershell)
  })
})
