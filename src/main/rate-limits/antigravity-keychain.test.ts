import { execFile } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  execFile: vi.fn()
}))

import { readAntigravityKeyring, writeAntigravityKeyring } from './antigravity-keychain'

const execFileMock = vi.mocked(execFile)
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

function invokeCallback(callback: unknown, error: Error | null, stdout = '', stderr = ''): void {
  const execCallback = callback as (error: Error | null, stdout: string, stderr: string) => void
  execCallback(error, stdout, stderr)
}

describe('Antigravity system keyring adapter', () => {
  beforeEach(() => {
    setPlatform('darwin')
    execFileMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('reads the official macOS service/account pair', async () => {
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      invokeCallback(callback, null, 'go-keyring-base64:record\n')
      return null as never
    })

    await expect(readAntigravityKeyring()).resolves.toEqual({
      status: 'found',
      value: 'go-keyring-base64:record'
    })
    expect(execFileMock.mock.calls[0]?.[1]).toEqual([
      'find-generic-password',
      '-s',
      'gemini',
      '-a',
      'antigravity',
      '-w'
    ])
  })

  it('writes rotated credentials back to the official macOS item', async () => {
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      invokeCallback(callback, null)
      return null as never
    })

    await writeAntigravityKeyring('rotated-record')

    expect(execFileMock.mock.calls[0]?.[1]).toEqual([
      'add-generic-password',
      '-U',
      '-s',
      'gemini',
      '-a',
      'antigravity',
      '-w',
      'rotated-record'
    ])
  })

  it('treats an absent macOS item as missing rather than a keyring failure', async () => {
    const notFound = Object.assign(new Error('not found'), { code: 44 })
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      invokeCallback(callback, notFound, '', 'could not be found')
      return null as never
    })

    await expect(readAntigravityKeyring()).resolves.toEqual({ status: 'missing' })
  })

  it('kills a pending keyring command when the fetch cycle aborts', async () => {
    const killMock = vi.fn()
    execFileMock.mockImplementationOnce(() => ({ kill: killMock }) as never)
    const controller = new AbortController()
    const read = readAntigravityKeyring(controller.signal)

    controller.abort()

    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
    expect(killMock).toHaveBeenCalled()
  })

  it('uses PowerShell credential-manager access on Windows', async () => {
    setPlatform('win32')
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      invokeCallback(callback, null, 'record')
      return null as never
    })

    await expect(readAntigravityKeyring()).resolves.toEqual({ status: 'found', value: 'record' })
    expect(execFileMock.mock.calls[0]?.[0]).toBe('powershell.exe')
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['-EncodedCommand', expect.any(String)])
    )
  })

  it('classifies an absent Linux Secret Service item as missing', async () => {
    setPlatform('linux')
    const notFound = Object.assign(new Error('secret not found'), { code: 1 })
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      invokeCallback(callback, notFound, '', 'secret not found')
      return null as never
    })

    await expect(readAntigravityKeyring()).resolves.toEqual({ status: 'missing' })
  })

  it('classifies a Linux Secret Service failure as unavailable', async () => {
    setPlatform('linux')
    const failure = Object.assign(new Error('dbus unavailable'), { code: 1 })
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      invokeCallback(callback, failure, '', 'dbus unavailable')
      return null as never
    })

    await expect(readAntigravityKeyring()).resolves.toEqual({ status: 'unavailable' })
  })
})
