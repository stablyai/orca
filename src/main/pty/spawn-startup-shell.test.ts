import { describe, expect, it } from 'vitest'

import { resolveSpawnStartupShell } from './spawn-startup-shell'

const base = {
  connectionId: null,
  windowsWslDistro: null,
  shellOverride: undefined,
  platform: 'darwin' as NodeJS.Platform
}

describe('resolveSpawnStartupShell', () => {
  it('uses posix on macOS and Linux', () => {
    expect(resolveSpawnStartupShell(base)).toBe('posix')
    expect(resolveSpawnStartupShell({ ...base, platform: 'linux' })).toBe('posix')
  })

  it('uses posix for an SSH pane even when the client is on Windows', () => {
    expect(resolveSpawnStartupShell({ ...base, platform: 'win32', connectionId: 'conn-1' })).toBe(
      'posix'
    )
  })

  it('uses posix for a WSL pane on a Windows host', () => {
    expect(
      resolveSpawnStartupShell({ ...base, platform: 'win32', windowsWslDistro: 'Ubuntu' })
    ).toBe('posix')
  })

  it('defaults a native Windows pane to powershell', () => {
    expect(resolveSpawnStartupShell({ ...base, platform: 'win32' })).toBe('powershell')
    expect(
      resolveSpawnStartupShell({
        ...base,
        platform: 'win32',
        shellOverride: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
      })
    ).toBe('powershell')
  })

  it('recognizes cmd and Git Bash overrides on Windows', () => {
    expect(
      resolveSpawnStartupShell({
        ...base,
        platform: 'win32',
        shellOverride: 'C:\\Windows\\System32\\cmd.exe'
      })
    ).toBe('cmd')
    expect(
      resolveSpawnStartupShell({
        ...base,
        platform: 'win32',
        shellOverride: 'C:\\Program Files\\Git\\bin\\bash.exe'
      })
    ).toBe('posix')
  })
})
