import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, execFileSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock
}))

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void

const originalUsername = process.env.USERNAME

beforeEach(() => {
  vi.resetModules()
  execFileMock.mockReset()
  execFileSyncMock.mockReset()
})

afterEach(() => {
  if (originalUsername === undefined) {
    delete process.env.USERNAME
  } else {
    process.env.USERNAME = originalUsername
  }
})

describe('grantDirAclAsync', () => {
  it('keeps icacls off the synchronous main-process path', async () => {
    process.env.USERNAME = 'alice'
    let complete: ExecCallback | undefined
    execFileMock.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: ExecCallback) => {
        complete = callback
        return {} as never
      }
    )
    const { getIcaclsExePath, grantDirAclAsync } = await import('./win32-utils')

    const pending = grantDirAclAsync('C:\\Users\\alice\\Orca')
    await Promise.resolve()

    expect(execFileSyncMock).not.toHaveBeenCalled()
    expect(execFileMock).toHaveBeenCalledWith(
      getIcaclsExePath(),
      ['C:\\Users\\alice\\Orca', '/grant:r', 'alice:(OI)(CI)(F)'],
      { encoding: 'utf-8', windowsHide: true, timeout: 10_000 },
      expect.any(Function)
    )
    complete?.(null, '', '')
    await expect(pending).resolves.toBeUndefined()
  })

  it('resolves a missing username through asynchronous whoami before icacls', async () => {
    delete process.env.USERNAME
    execFileMock
      .mockImplementationOnce(
        (_command: string, _args: string[], _options: unknown, callback: ExecCallback) => {
          callback(null, '"DOMAIN\\alice","S-1-5-21-123"\r\n', '')
          return {} as never
        }
      )
      .mockImplementationOnce(
        (_command: string, _args: string[], _options: unknown, callback: ExecCallback) => {
          callback(null, '', '')
          return {} as never
        }
      )
    const { getWhoamiExePath, grantDirAclAsync } = await import('./win32-utils')

    await grantDirAclAsync('C:\\Orca')

    expect(execFileMock.mock.calls[0]?.slice(0, 3)).toEqual([
      getWhoamiExePath(),
      ['/user', '/fo', 'csv', '/nh'],
      { encoding: 'utf-8', windowsHide: true, timeout: 5000 }
    ])
    expect(execFileMock.mock.calls[1]?.[1]).toEqual([
      'C:\\Orca',
      '/grant:r',
      '*S-1-5-21-123:(OI)(CI)(F)'
    ])
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it('does not overwrite a concurrent cached identity with a late async result', async () => {
    delete process.env.USERNAME
    let completeWhoami: ExecCallback | undefined
    execFileMock
      .mockImplementationOnce(
        (_command: string, _args: string[], _options: unknown, callback: ExecCallback) => {
          completeWhoami = callback
          return {} as never
        }
      )
      .mockImplementationOnce(
        (_command: string, _args: string[], _options: unknown, callback: ExecCallback) => {
          callback(null, '', '')
          return {} as never
        }
      )
    execFileSyncMock.mockReturnValue('"DOMAIN\\sync","S-1-5-21-456"\r\n')
    const { grantDirAclAsync, resolveCurrentWindowsIdentity } = await import('./win32-utils')

    const pending = grantDirAclAsync('C:\\Orca')
    await Promise.resolve()
    expect(resolveCurrentWindowsIdentity()).toBe('*S-1-5-21-456')
    completeWhoami?.(null, '"DOMAIN\\async","S-1-5-21-789"\r\n', '')
    await pending

    expect(execFileMock.mock.calls[1]?.[1]).toEqual([
      'C:\\Orca',
      '/grant:r',
      '*S-1-5-21-456:(OI)(CI)(F)'
    ])
  })

  it('retries identity resolution after a transient whoami failure', async () => {
    delete process.env.USERNAME
    execFileMock
      .mockImplementationOnce(
        (_command: string, _args: string[], _options: unknown, callback: ExecCallback) => {
          callback(new Error('whoami timed out'), '', '')
          return {} as never
        }
      )
      .mockImplementationOnce(
        (_command: string, _args: string[], _options: unknown, callback: ExecCallback) => {
          callback(null, '"DOMAIN\\alice","S-1-5-21-123"\r\n', '')
          return {} as never
        }
      )
      .mockImplementationOnce(
        (_command: string, _args: string[], _options: unknown, callback: ExecCallback) => {
          callback(null, '', '')
          return {} as never
        }
      )
    const { getWhoamiExePath, grantDirAclAsync } = await import('./win32-utils')

    await grantDirAclAsync('C:\\Orca')
    await grantDirAclAsync('C:\\Orca')

    expect(
      execFileMock.mock.calls.filter(([command]) => command === getWhoamiExePath())
    ).toHaveLength(2)
    expect(execFileMock.mock.calls[2]?.[1]).toEqual([
      'C:\\Orca',
      '/grant:r',
      '*S-1-5-21-123:(OI)(CI)(F)'
    ])
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })
})
