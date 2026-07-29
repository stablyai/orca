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

  it('honors a direct pwsh.exe shell request even when the availability probe is false', () => {
    expect(
      resolveEffectiveWindowsPowerShell({
        shellFamily: 'pwsh.exe',
        implementation: 'powershell.exe',
        pwshAvailable: false
      })
    ).toBe('pwsh.exe')
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

  it('keeps an explicit pwsh.exe preference when the availability probe is false', () => {
    expect(
      resolveEffectiveWindowsPowerShell({
        shellFamily: 'powershell.exe',
        implementation: 'pwsh.exe',
        pwshAvailable: false
      })
    ).toBe('pwsh.exe')
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
