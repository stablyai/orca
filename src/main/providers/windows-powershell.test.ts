import { describe, expect, it } from 'vitest'
import { resolveEffectiveWindowsPowerShell } from './windows-powershell'

describe('resolveEffectiveWindowsPowerShell', () => {
  it('returns null for non-PowerShell shell families', () => {
    expect(
      resolveEffectiveWindowsPowerShell({
        shellFamily: 'cmd.exe',
        implementation: 'pwsh.exe',
        pwshAvailable: true
      })
    ).toBeNull()

    expect(
      resolveEffectiveWindowsPowerShell({
        shellFamily: 'wsl.exe',
        implementation: 'powershell.exe',
        pwshAvailable: true
      })
    ).toBeNull()

    expect(
      resolveEffectiveWindowsPowerShell({
        shellFamily: undefined,
        implementation: 'pwsh.exe',
        pwshAvailable: true
      })
    ).toBeNull()
  })

  it('returns powershell.exe when the saved implementation is powershell.exe', () => {
    expect(
      resolveEffectiveWindowsPowerShell({
        shellFamily: 'powershell.exe',
        implementation: 'powershell.exe',
        pwshAvailable: true
      })
    ).toBe('powershell.exe')
  })

  it('returns pwsh.exe when the saved implementation is pwsh.exe and pwsh is available', () => {
    expect(
      resolveEffectiveWindowsPowerShell({
        shellFamily: 'powershell.exe',
        implementation: 'pwsh.exe',
        pwshAvailable: true
      })
    ).toBe('pwsh.exe')
  })

  it('falls back to powershell.exe when pwsh is preferred but unavailable', () => {
    expect(
      resolveEffectiveWindowsPowerShell({
        shellFamily: 'powershell.exe',
        implementation: 'pwsh.exe',
        pwshAvailable: false
      })
    ).toBe('powershell.exe')
  })

  it('uses pwsh.exe for Auto when pwsh is available', () => {
    expect(
      resolveEffectiveWindowsPowerShell({
        shellFamily: 'powershell.exe',
        implementation: 'auto',
        pwshAvailable: true
      })
    ).toBe('pwsh.exe')
  })

  it('uses powershell.exe for Auto when pwsh is unavailable', () => {
    expect(
      resolveEffectiveWindowsPowerShell({
        shellFamily: 'powershell.exe',
        implementation: 'auto',
        pwshAvailable: false
      })
    ).toBe('powershell.exe')
  })

  it('defaults to Auto when no implementation is persisted', () => {
    expect(
      resolveEffectiveWindowsPowerShell({
        shellFamily: 'powershell.exe',
        implementation: undefined,
        pwshAvailable: true
      })
    ).toBe('pwsh.exe')
  })
})
