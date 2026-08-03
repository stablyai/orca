import { describe, expect, it, vi } from 'vitest'

const { defaultExecFileMock, defaultExecFileSyncMock } = vi.hoisted(() => ({
  defaultExecFileMock: vi.fn(),
  defaultExecFileSyncMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: defaultExecFileMock,
  execFileSync: defaultExecFileSyncMock
}))

import {
  __resetPersistedWindowsPathCacheForTests,
  mergePersistedWindowsPath,
  mergePersistedWindowsPathAsync,
  readPersistedWindowsPathSegments,
  readPersistedWindowsPathSegmentsAsync
} from './windows-environment-path'

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void

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
    expect(execFileSync).toHaveBeenCalledTimes(2)
    expect(
      execFileSync.mock.calls.every(([command]) => command === 'C:\\Windows\\System32\\reg.exe')
    ).toBe(true)
  })

  it('returns an empty list outside Windows', () => {
    const execFileSync = vi.fn()

    expect(readPersistedWindowsPathSegments({ platform: 'linux', execFileSync })).toEqual([])
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('does not start asynchronous registry reads outside Windows', async () => {
    await expect(readPersistedWindowsPathSegmentsAsync({ platform: 'linux' })).resolves.toEqual([])
    expect(defaultExecFileMock).not.toHaveBeenCalled()
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

  it('force-refreshes the production registry cache', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    defaultExecFileSyncMock
      .mockReturnValueOnce('    Path    REG_SZ    C:\\Machine\r\n')
      .mockReturnValueOnce('    Path    REG_SZ    C:\\User\r\n')
      .mockReturnValueOnce('    Path    REG_SZ    C:\\Machine\r\n')
      .mockReturnValueOnce('    Path    REG_SZ    C:\\User;C:\\Program Files\\GitHub CLI\r\n')
    __resetPersistedWindowsPathCacheForTests()

    try {
      expect(readPersistedWindowsPathSegments()).toEqual(['C:\\Machine', 'C:\\User'])
      expect(readPersistedWindowsPathSegments()).toEqual(['C:\\Machine', 'C:\\User'])
      expect(defaultExecFileSyncMock).toHaveBeenCalledTimes(2)

      expect(readPersistedWindowsPathSegments({ forceRefresh: true })).toEqual([
        'C:\\Machine',
        'C:\\User',
        'C:\\Program Files\\GitHub CLI'
      ])
      expect(defaultExecFileSyncMock).toHaveBeenCalledTimes(4)
    } finally {
      __resetPersistedWindowsPathCacheForTests()
      defaultExecFileSyncMock.mockReset()
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('keeps the last good segments when a forced read hits a blocked registry', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    defaultExecFileSyncMock
      .mockReturnValueOnce('    Path    REG_SZ    C:\\Machine\r\n')
      .mockReturnValueOnce('    Path    REG_SZ    C:\\User\r\n')
      .mockImplementation(() => {
        throw new Error('ERROR: Access is denied.')
      })
    __resetPersistedWindowsPathCacheForTests()

    try {
      expect(readPersistedWindowsPathSegments()).toEqual(['C:\\Machine', 'C:\\User'])
      expect(readPersistedWindowsPathSegments({ forceRefresh: true })).toEqual([
        'C:\\Machine',
        'C:\\User'
      ])
      expect(readPersistedWindowsPathSegments()).toEqual(['C:\\Machine', 'C:\\User'])
    } finally {
      __resetPersistedWindowsPathCacheForTests()
      defaultExecFileSyncMock.mockReset()
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('still clears the cache when the registry reports an empty Path', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    defaultExecFileSyncMock
      .mockReturnValueOnce('    Path    REG_SZ    C:\\Machine\r\n')
      .mockReturnValueOnce('    Path    REG_SZ    C:\\User\r\n')
      .mockReturnValue('    Path    REG_SZ    \r\n')
    __resetPersistedWindowsPathCacheForTests()

    try {
      expect(readPersistedWindowsPathSegments()).toEqual(['C:\\Machine', 'C:\\User'])

      // Why: an emptied persisted Path is a successful read, not a blocked one —
      // it must not be mistaken for the failure case and served from the cache.
      expect(readPersistedWindowsPathSegments({ forceRefresh: true })).toEqual([])
      expect(readPersistedWindowsPathSegments()).toEqual([])
    } finally {
      __resetPersistedWindowsPathCacheForTests()
      defaultExecFileSyncMock.mockReset()
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('deduplicates concurrent forced asynchronous refreshes and merges each environment', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const callbacks: ExecCallback[] = []
    defaultExecFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecCallback) => {
        callbacks.push(callback)
        return {} as never
      }
    )
    __resetPersistedWindowsPathCacheForTests()

    try {
      const firstEnv = { Path: 'C:\\First' }
      const secondEnv = { Path: 'C:\\Second' }
      const first = mergePersistedWindowsPathAsync(firstEnv, { forceRefresh: true })
      const second = mergePersistedWindowsPathAsync(secondEnv, { forceRefresh: true })

      expect(defaultExecFileMock).toHaveBeenCalledTimes(2)
      callbacks[0]?.(null, '    Path    REG_SZ    C:\\Machine\r\n', '')
      callbacks[1]?.(null, '    Path    REG_SZ    C:\\User\r\n', '')
      await Promise.all([first, second])
      expect(firstEnv.Path).toBe('C:\\First;C:\\Machine;C:\\User')
      expect(secondEnv.Path).toBe('C:\\Second;C:\\Machine;C:\\User')
    } finally {
      __resetPersistedWindowsPathCacheForTests()
      defaultExecFileMock.mockReset()
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('keeps the last good cache when bounded asynchronous reads time out', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    defaultExecFileMock
      .mockImplementationOnce(
        (_file: string, _args: string[], _options: unknown, callback: ExecCallback) => {
          callback(null, '    Path    REG_SZ    C:\\Machine\r\n', '')
          return {} as never
        }
      )
      .mockImplementationOnce(
        (_file: string, _args: string[], _options: unknown, callback: ExecCallback) => {
          callback(null, '    Path    REG_SZ    C:\\User\r\n', '')
          return {} as never
        }
      )
      .mockImplementation(
        (_file: string, _args: string[], _options: unknown, callback: ExecCallback) => {
          callback(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), '', '')
          return {} as never
        }
      )
    __resetPersistedWindowsPathCacheForTests()

    try {
      await expect(readPersistedWindowsPathSegmentsAsync()).resolves.toEqual([
        'C:\\Machine',
        'C:\\User'
      ])
      await expect(readPersistedWindowsPathSegmentsAsync()).resolves.toEqual([
        'C:\\Machine',
        'C:\\User'
      ])
      expect(defaultExecFileMock).toHaveBeenCalledTimes(2)
      await expect(readPersistedWindowsPathSegmentsAsync({ forceRefresh: true })).resolves.toEqual([
        'C:\\Machine',
        'C:\\User'
      ])
      await expect(readPersistedWindowsPathSegmentsAsync()).resolves.toEqual([
        'C:\\Machine',
        'C:\\User'
      ])
      expect(defaultExecFileMock).toHaveBeenCalledTimes(4)
      expect(defaultExecFileMock.mock.calls[2]?.[2]).toMatchObject({ timeout: 5_000 })
    } finally {
      __resetPersistedWindowsPathCacheForTests()
      defaultExecFileMock.mockReset()
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })
})

describe('mergePersistedWindowsPath', () => {
  it('expands variables already present in the inherited PATH', () => {
    const execFileSync = vi.fn().mockReturnValue('    Path    REG_SZ    \r\n')
    const env = {
      ORCA_PATH_ROOT: 'C:\\Users\\orca\\AppData\\Local',
      Path: '%orca_path_root%\\agy\\bin;C:\\Windows'
    }

    mergePersistedWindowsPath(env, { platform: 'win32', execFileSync, env })

    expect(env.Path).toBe('C:\\Users\\orca\\AppData\\Local\\agy\\bin;C:\\Windows')
  })

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
