import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '../shared/child-process/run-process'

const { runProcessMock, runProcessSyncMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  runProcessSyncMock: vi.fn()
}))

vi.mock('../shared/child-process/run-process', () => ({
  runProcess: runProcessMock,
  runProcessSync: runProcessSyncMock
}))

const exited = (stdout = '', code = 0): ProcessResult => ({
  code,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false
})

const originalUsername = process.env.USERNAME

beforeEach(() => {
  vi.resetModules()
  runProcessMock.mockReset()
  runProcessSyncMock.mockReset()
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
    const deferred = Promise.withResolvers<ProcessResult>()
    runProcessMock.mockImplementation(() => deferred.promise)
    const { getIcaclsExePath, grantDirAclAsync } = await import('./win32-utils')

    const pending = grantDirAclAsync('C:\\Users\\alice\\Orca')
    await Promise.resolve()

    expect(runProcessSyncMock).not.toHaveBeenCalled()
    expect(runProcessMock).toHaveBeenCalledWith({
      program: getIcaclsExePath(),
      args: ['C:\\Users\\alice\\Orca', '/grant:r', 'alice:(OI)(CI)(F)'],
      timeoutMs: 10_000
    })
    deferred.resolve(exited())
    await expect(pending).resolves.toBeUndefined()
  })

  it('rejects when icacls reports a non-zero exit', async () => {
    process.env.USERNAME = 'alice'
    runProcessMock.mockResolvedValue({ ...exited('', 5), stderr: 'Access is denied.' })
    const { grantDirAclAsync } = await import('./win32-utils')

    await expect(grantDirAclAsync('C:\\Orca')).rejects.toThrow('Access is denied.')
  })

  it('resolves a missing username through asynchronous whoami before icacls', async () => {
    delete process.env.USERNAME
    runProcessMock
      .mockResolvedValueOnce(exited('"DOMAIN\\alice","S-1-5-21-123"\r\n'))
      .mockResolvedValueOnce(exited())
    const { getWhoamiExePath, grantDirAclAsync } = await import('./win32-utils')

    await grantDirAclAsync('C:\\Orca')

    expect(runProcessMock.mock.calls[0]?.[0]).toEqual({
      program: getWhoamiExePath(),
      args: ['/user', '/fo', 'csv', '/nh'],
      timeoutMs: 5000
    })
    expect(runProcessMock.mock.calls[1]?.[0].args).toEqual([
      'C:\\Orca',
      '/grant:r',
      '*S-1-5-21-123:(OI)(CI)(F)'
    ])
    expect(runProcessSyncMock).not.toHaveBeenCalled()
  })

  it('spawns whoami once for concurrent and repeated ACL grants', async () => {
    delete process.env.USERNAME
    runProcessMock.mockImplementation(({ args }: { args: readonly string[] }) =>
      Promise.resolve(args[0] === '/user' ? exited('"DOMAIN\\alice","S-1-5-21-123"\r\n') : exited())
    )
    const { getWhoamiExePath, grantDirAclAsync } = await import('./win32-utils')

    await Promise.all([grantDirAclAsync('C:\\Orca'), grantDirAclAsync('C:\\Orca\\two')])
    await grantDirAclAsync('C:\\Orca\\three')

    expect(
      runProcessMock.mock.calls.filter(([spec]) => spec.program === getWhoamiExePath())
    ).toHaveLength(1)
    expect(runProcessSyncMock).not.toHaveBeenCalled()
  })

  it('does not overwrite a concurrent cached identity with a late async result', async () => {
    delete process.env.USERNAME
    const deferred = Promise.withResolvers<ProcessResult>()
    runProcessMock.mockImplementationOnce(() => deferred.promise).mockResolvedValueOnce(exited())
    runProcessSyncMock.mockReturnValue(exited('"DOMAIN\\sync","S-1-5-21-456"\r\n'))
    const { grantDirAclAsync, resolveCurrentWindowsIdentity } = await import('./win32-utils')

    const pending = grantDirAclAsync('C:\\Orca')
    await Promise.resolve()
    expect(resolveCurrentWindowsIdentity()).toBe('*S-1-5-21-456')
    deferred.resolve(exited('"DOMAIN\\async","S-1-5-21-789"\r\n'))
    await pending

    expect(runProcessMock.mock.calls[1]?.[0].args).toEqual([
      'C:\\Orca',
      '/grant:r',
      '*S-1-5-21-456:(OI)(CI)(F)'
    ])
  })

  it('retries identity resolution after a transient whoami failure', async () => {
    delete process.env.USERNAME
    runProcessMock
      .mockRejectedValueOnce(new Error('whoami timed out'))
      .mockResolvedValueOnce(exited('"DOMAIN\\alice","S-1-5-21-123"\r\n'))
      .mockResolvedValueOnce(exited())
    const { getWhoamiExePath, grantDirAclAsync } = await import('./win32-utils')

    await grantDirAclAsync('C:\\Orca')
    await grantDirAclAsync('C:\\Orca')

    expect(
      runProcessMock.mock.calls.filter(([spec]) => spec.program === getWhoamiExePath())
    ).toHaveLength(2)
    expect(runProcessMock.mock.calls[2]?.[0].args).toEqual([
      'C:\\Orca',
      '/grant:r',
      '*S-1-5-21-123:(OI)(CI)(F)'
    ])
    expect(runProcessSyncMock).not.toHaveBeenCalled()
  })
})
