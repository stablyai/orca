import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'

const { execFileAsyncMock } = vi.hoisted(() => ({ execFileAsyncMock: vi.fn() }))

vi.mock('node:child_process', () => {
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: execFileAsyncMock })
  return { execFile }
})

import {
  readManagedHookHostIdentity,
  readManagedHookProcessIdentity
} from './managed-hook-owner-identity'

const originalPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  vi.unstubAllEnvs()
  execFileAsyncMock.mockReset()
})

it('resolves absolute reg.exe and powershell.exe paths when SystemRoot is blank', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  vi.stubEnv('SystemRoot', '')
  vi.stubEnv('SYSTEMROOT', '')
  vi.stubEnv('windir', '')
  vi.stubEnv('WINDIR', 'D:\\Windows')

  execFileAsyncMock
    .mockResolvedValueOnce({
      stdout: '    MachineGuid    REG_SZ    12345678-1234-4123-8123-123456789abc\r\n',
      stderr: ''
    })
    .mockResolvedValueOnce({
      stdout: '1700000000000\r\n',
      stderr: ''
    })

  await expect(readManagedHookHostIdentity()).resolves.toBe(
    'win32:12345678-1234-4123-8123-123456789abc'
  )
  await expect(readManagedHookProcessIdentity(process.pid + 1)).resolves.toBe(
    `win32:${process.pid + 1}:1700000000000`
  )

  expect(execFileAsyncMock).toHaveBeenNthCalledWith(
    1,
    'D:\\Windows\\System32\\reg.exe',
    expect.any(Array),
    expect.objectContaining({ windowsHide: true })
  )
  expect(execFileAsyncMock).toHaveBeenNthCalledWith(
    2,
    'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    expect.any(Array),
    expect.objectContaining({ windowsHide: true })
  )
})
