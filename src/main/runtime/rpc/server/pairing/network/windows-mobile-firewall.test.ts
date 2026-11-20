import { afterEach, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { inspectWindowsMobileFirewall } from './windows-mobile-firewall'

afterEach(() => {
  execFileMock.mockReset()
})

it('resolves an absolute PowerShell path when systemRoot is blank', async () => {
  execFileMock.mockImplementation(
    (
      _program: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void
    ) => {
      callback(
        null,
        JSON.stringify({
          matchingRuleScopes: ['Any'],
          blockingRuleDetected: false,
          privateFirewallEnabled: true,
          networkCategory: 'Private'
        })
      )
    }
  )

  const status = await inspectWindowsMobileFirewall(4455, '192.168.1.5', {
    platform: 'win32',
    isPackaged: true,
    executablePath: 'C:\\Program Files\\Orca\\Orca.exe',
    systemRoot: '   '
  })

  expect(status.supported).toBe(true)
  expect(execFileMock).toHaveBeenCalledWith(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    expect.any(Array),
    expect.objectContaining({ windowsHide: true }),
    expect.any(Function)
  )
})
