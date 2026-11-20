import { afterEach, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { getWindowsDefaultRouteInterfaceNames } from './windows-default-route-interfaces'

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
      callback(null, '["Wi-Fi"]')
    }
  )

  const names = await getWindowsDefaultRouteInterfaceNames({
    platform: 'win32',
    systemRoot: ''
  })

  expect(names).toEqual(new Set(['Wi-Fi']))
  expect(execFileMock).toHaveBeenCalledWith(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    expect.any(Array),
    expect.objectContaining({ windowsHide: true }),
    expect.any(Function)
  )
})

// A blank override must not hide the real env: an install off C: is only reachable through windir.
it('falls back to the host env when systemRoot is blank', async () => {
  vi.stubEnv('SystemRoot', '')
  vi.stubEnv('WINDIR', 'D:\\Windows')
  execFileMock.mockImplementation(
    (
      _program: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void
    ) => {
      callback(null, '["Ethernet"]')
    }
  )

  await getWindowsDefaultRouteInterfaceNames({ platform: 'win32', systemRoot: '   ' })

  expect(execFileMock).toHaveBeenCalledWith(
    'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    expect.any(Array),
    expect.objectContaining({ windowsHide: true }),
    expect.any(Function)
  )
  vi.unstubAllEnvs()
})
