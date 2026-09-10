import { describe, expect, it } from 'vitest'
import { resolveAgentResumeStartupShell } from './agent-resume-startup-shell-resolution'

describe('resolveAgentResumeStartupShell', () => {
  it('uses the client shell for a local win32 target', () => {
    expect(
      resolveAgentResumeStartupShell({
        requestedStartupShell: 'cmd',
        platform: 'win32',
        isRemote: false,
        terminalWindowsShell: 'powershell.exe'
      })
    ).toBe('cmd')
  })

  it('falls back to the global setting when the client sends nothing', () => {
    expect(
      resolveAgentResumeStartupShell({
        platform: 'win32',
        isRemote: false,
        terminalWindowsShell: 'cmd.exe'
      })
    ).toBe('cmd')
  })

  it('ignores the client shell for a remote target', () => {
    expect(
      resolveAgentResumeStartupShell({
        requestedStartupShell: 'cmd',
        platform: 'win32',
        isRemote: true,
        terminalWindowsShell: 'powershell.exe'
      })
    ).toBeUndefined()
  })

  it('ignores the client shell for a non-Windows target', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(
        resolveAgentResumeStartupShell({
          requestedStartupShell: 'powershell',
          platform,
          isRemote: false,
          terminalWindowsShell: 'powershell.exe'
        })
      ).toBeUndefined()
    }
  })
})
