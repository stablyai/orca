import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { accessSyncMock, existsSyncMock, statSyncMock } = vi.hoisted(() => ({
  accessSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
  statSyncMock: vi.fn()
}))

vi.mock('node:fs', () => ({
  accessSync: accessSyncMock,
  constants: { O_RDONLY: 0, O_NONBLOCK: 4, X_OK: 1 },
  existsSync: existsSyncMock,
  statSync: statSyncMock
}))

import { findSystemSsh } from './system-ssh-binary'

describe('findSystemSsh', () => {
  beforeEach(() => {
    accessSyncMock.mockReset()
    existsSyncMock.mockReset()
    statSyncMock.mockReset()
    statSyncMock.mockImplementation(() => {
      throw new Error('missing')
    })
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns the first existing fixed ssh path', () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    existsSyncMock.mockImplementation((path: string) => path === '/usr/bin/ssh')

    try {
      expect(findSystemSsh()).toBe('/usr/bin/ssh')
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('returns null when no ssh binary is found', () => {
    existsSyncMock.mockReturnValue(false)
    expect(findSystemSsh()).toBeNull()
  })

  it('finds a PATH-installed ssh.exe on Windows', () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.stubEnv('PATH', 'C:\\Git\\usr\\bin;C:\\Tools')
    existsSyncMock.mockReturnValue(false)
    statSyncMock.mockImplementation((path: string) => {
      if (path === 'C:\\Git\\usr\\bin\\ssh.exe') {
        return { isFile: () => true }
      }
      throw new Error('missing')
    })

    try {
      expect(findSystemSsh()).toBe('C:\\Git\\usr\\bin\\ssh.exe')
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('finds an executable PATH-installed ssh on POSIX', () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.stubEnv('PATH', '/nix/store/ssh/bin:/opt/tools')
    existsSyncMock.mockReturnValue(false)
    statSyncMock.mockImplementation((path: string) => {
      if (path === '/nix/store/ssh/bin/ssh') {
        return { isFile: () => true }
      }
      throw new Error('missing')
    })

    try {
      expect(findSystemSsh()).toBe('/nix/store/ssh/bin/ssh')
      expect(accessSyncMock).toHaveBeenCalledWith('/nix/store/ssh/bin/ssh', expect.any(Number))
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('resolves Windows OpenSSH from the runtime system root', () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.stubEnv('SystemRoot', 'D:\\Windows')
    existsSyncMock.mockImplementation(
      (path: string) => path === 'D:\\Windows\\System32\\OpenSSH\\ssh.exe'
    )

    try {
      expect(findSystemSsh()).toBe('D:\\Windows\\System32\\OpenSSH\\ssh.exe')
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('keeps an explicit system ssh override authoritative', () => {
    vi.stubEnv('ORCA_SYSTEM_SSH_PATH', 'C:\\Custom\\ssh.exe')

    expect(findSystemSsh()).toBe('C:\\Custom\\ssh.exe')
    expect(existsSyncMock).not.toHaveBeenCalled()
  })
})
