import { describe, expect, it, vi } from 'vitest'

const { defaultExecFileSyncMock } = vi.hoisted(() => ({
  defaultExecFileSyncMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFileSync: defaultExecFileSyncMock
}))

import {
  __resetPersistedWindowsPathCacheForTests,
  mergePersistedWindowsPath,
  readPersistedWindowsPathSegments
} from './windows-environment-path'

describe('readPersistedWindowsPathSegments', () => {
  it('reads machine and user Path values from the Windows registry', () => {
    const execFileSync = vi
      .fn()
      .mockReturnValueOnce(
        [
          '',
          'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
          '    Path    REG_EXPAND_SZ    %SystemRoot%\\System32;C:\\Tools',
          ''
        ].join('\r\n')
      )
      .mockReturnValueOnce(
        ['', 'HKEY_CURRENT_USER\\Environment', '    Path    REG_SZ    C:\\Users\\me\\bin', ''].join(
          '\r\n'
        )
      )

    const segments = readPersistedWindowsPathSegments({
      platform: 'win32',
      execFileSync,
      env: { SystemRoot: 'C:\\Windows' }
    })

    expect(segments).toEqual(['C:\\Windows\\System32', 'C:\\Tools', 'C:\\Users\\me\\bin'])
  })

  it('returns an empty list outside Windows', () => {
    const execFileSync = vi.fn()

    expect(readPersistedWindowsPathSegments({ platform: 'linux', execFileSync })).toEqual([])
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('caches production registry reads briefly', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    defaultExecFileSyncMock
      .mockReturnValueOnce('    Path    REG_SZ    C:\\Machine\r\n')
      .mockReturnValueOnce('    Path    REG_SZ    C:\\User\r\n')
    __resetPersistedWindowsPathCacheForTests()

    try {
      expect(readPersistedWindowsPathSegments()).toEqual(['C:\\Machine', 'C:\\User'])
      expect(readPersistedWindowsPathSegments()).toEqual(['C:\\Machine', 'C:\\User'])
      expect(defaultExecFileSyncMock).toHaveBeenCalledTimes(2)
    } finally {
      __resetPersistedWindowsPathCacheForTests()
      defaultExecFileSyncMock.mockReset()
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })
})

describe('mergePersistedWindowsPath', () => {
  it('appends missing persisted segments without reordering the inherited PATH', () => {
    const execFileSync = vi
      .fn()
      .mockReturnValueOnce(
        [
          '',
          'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
          '    Path    REG_EXPAND_SZ    C:\\Windows\\System32;C:\\Existing',
          ''
        ].join('\r\n')
      )
      .mockReturnValueOnce(
        [
          '',
          'HKEY_CURRENT_USER\\Environment',
          '    Path    REG_EXPAND_SZ    C:\\Users\\me\\AppData\\Local\\Orca\\bin;C:\\Existing',
          ''
        ].join('\r\n')
      )
    const env = { Path: 'C:\\Existing' }

    mergePersistedWindowsPath(env, { platform: 'win32', execFileSync })

    expect(env.Path).toBe(
      'C:\\Existing;C:\\Windows\\System32;C:\\Users\\me\\AppData\\Local\\Orca\\bin'
    )
  })

  it('uses PATH when that is the existing path key', () => {
    const execFileSync = vi
      .fn()
      .mockReturnValueOnce('    Path    REG_SZ    C:\\Machine\r\n')
      .mockReturnValueOnce('    Path    REG_SZ    C:\\User\r\n')
    const env = { PATH: 'C:\\Current' }

    mergePersistedWindowsPath(env, { platform: 'win32', execFileSync })

    expect(env).toEqual({ PATH: 'C:\\Current;C:\\Machine;C:\\User' })
  })

  it('keeps the inherited process PATH when the target env has no path key', () => {
    const execFileSync = vi
      .fn()
      .mockReturnValueOnce('    Path    REG_SZ    C:\\Machine\r\n')
      .mockReturnValueOnce('    Path    REG_SZ    C:\\User\r\n')
    const env: Record<string, string> = {}

    mergePersistedWindowsPath(env, {
      platform: 'win32',
      execFileSync,
      env: { Path: 'C:\\Inherited' }
    })

    expect(env).toEqual({ Path: 'C:\\Inherited;C:\\Machine;C:\\User' })
  })
})
