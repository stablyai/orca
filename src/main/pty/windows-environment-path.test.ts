import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  invalidatePersistedWindowsPathCache,
  mergePersistedWindowsPath,
  mergePersistedWindowsPathAsync,
  readPersistedWindowsPathSegments,
  readPersistedWindowsPathSegmentsAsync,
  resolvePathEnvKey
} from './windows-environment-path'
import { __setWindowsPathRegistryLoaderForTests } from './windows-path-registry-reader'

const registryGetKeyMock = vi.fn()

function registryPath(value: string): Record<string, unknown> {
  return { Path: { type: 1, value } }
}

beforeEach(() => {
  registryGetKeyMock.mockReset()
  __setWindowsPathRegistryLoaderForTests(() => ({
    HK: { LM: 1, CU: 2 },
    getRegistryKey: registryGetKeyMock
  }))
})

afterEach(() => {
  __resetPersistedWindowsPathCacheForTests()
  __setWindowsPathRegistryLoaderForTests()
})

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
    registryGetKeyMock
      .mockReturnValueOnce(registryPath('C:\\Machine'))
      .mockReturnValueOnce(registryPath('C:\\User'))
    __resetPersistedWindowsPathCacheForTests()

    try {
      expect(readPersistedWindowsPathSegments()).toEqual(['C:\\Machine', 'C:\\User'])
      expect(readPersistedWindowsPathSegments()).toEqual(['C:\\Machine', 'C:\\User'])
      expect(registryGetKeyMock).toHaveBeenCalledTimes(2)
    } finally {
      __resetPersistedWindowsPathCacheForTests()
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('force-refreshes the production registry cache', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    registryGetKeyMock
      .mockReturnValueOnce(registryPath('C:\\Machine'))
      .mockReturnValueOnce(registryPath('C:\\User'))
      .mockReturnValueOnce(registryPath('C:\\Machine'))
      .mockReturnValueOnce(registryPath('C:\\User;C:\\Program Files\\GitHub CLI'))
    __resetPersistedWindowsPathCacheForTests()

    try {
      expect(readPersistedWindowsPathSegments()).toEqual(['C:\\Machine', 'C:\\User'])
      expect(readPersistedWindowsPathSegments()).toEqual(['C:\\Machine', 'C:\\User'])
      expect(registryGetKeyMock).toHaveBeenCalledTimes(2)

      expect(readPersistedWindowsPathSegments({ forceRefresh: true })).toEqual([
        'C:\\Machine',
        'C:\\User',
        'C:\\Program Files\\GitHub CLI'
      ])
      expect(registryGetKeyMock).toHaveBeenCalledTimes(4)
    } finally {
      __resetPersistedWindowsPathCacheForTests()
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('invalidates the cache after Windows reports an environment change', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    registryGetKeyMock
      .mockReturnValueOnce(registryPath('C:\\OldMachine'))
      .mockReturnValueOnce(registryPath('C:\\OldUser'))
      .mockReturnValueOnce(registryPath('C:\\NewMachine'))
      .mockReturnValueOnce(registryPath('C:\\NewUser'))
    __resetPersistedWindowsPathCacheForTests()

    try {
      expect(readPersistedWindowsPathSegments()).toEqual(['C:\\OldMachine', 'C:\\OldUser'])
      expect(readPersistedWindowsPathSegments()).toEqual(['C:\\OldMachine', 'C:\\OldUser'])

      invalidatePersistedWindowsPathCache()

      expect(readPersistedWindowsPathSegments()).toEqual(['C:\\NewMachine', 'C:\\NewUser'])
      expect(registryGetKeyMock).toHaveBeenCalledTimes(4)
    } finally {
      __resetPersistedWindowsPathCacheForTests()
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('combines a fresh hive with the other hive last known good after invalidation', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    registryGetKeyMock
      .mockReturnValueOnce(registryPath('C:\\OldMachine'))
      .mockReturnValueOnce(registryPath('C:\\OldUser'))
      .mockReturnValueOnce(registryPath('C:\\NewMachine'))
      .mockImplementationOnce(() => {
        throw new Error('user registry unavailable')
      })
    __resetPersistedWindowsPathCacheForTests()

    try {
      expect(readPersistedWindowsPathSegments()).toEqual(['C:\\OldMachine', 'C:\\OldUser'])
      invalidatePersistedWindowsPathCache()

      expect(readPersistedWindowsPathSegments()).toEqual(['C:\\NewMachine', 'C:\\OldUser'])
      expect(registryGetKeyMock).toHaveBeenCalledTimes(4)
    } finally {
      __resetPersistedWindowsPathCacheForTests()
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('combines a fresh user hive with the machine hive last known good', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    registryGetKeyMock
      .mockReturnValueOnce(registryPath('C:\\OldMachine'))
      .mockReturnValueOnce(registryPath('C:\\OldUser'))
      .mockImplementationOnce(() => {
        throw new Error('machine registry unavailable')
      })
      .mockReturnValueOnce(registryPath('C:\\NewUser'))
    __resetPersistedWindowsPathCacheForTests()

    try {
      expect(readPersistedWindowsPathSegments()).toEqual(['C:\\OldMachine', 'C:\\OldUser'])
      invalidatePersistedWindowsPathCache()

      expect(readPersistedWindowsPathSegments()).toEqual(['C:\\OldMachine', 'C:\\NewUser'])
    } finally {
      __resetPersistedWindowsPathCacheForTests()
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('withholds a partial first registry snapshot instead of changing PATH precedence', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    registryGetKeyMock
      .mockReturnValueOnce(registryPath('C:\\Machine'))
      .mockImplementationOnce(() => {
        throw new Error('user registry unavailable')
      })
    __resetPersistedWindowsPathCacheForTests()

    try {
      const env = { Path: 'C:\\UserAlias;C:\\Existing' }

      mergePersistedWindowsPath(env)

      expect(env.Path).toBe('C:\\UserAlias;C:\\Existing')
      expect(readPersistedWindowsPathSegments()).toEqual([])
      expect(registryGetKeyMock).toHaveBeenCalledTimes(2)
    } finally {
      __resetPersistedWindowsPathCacheForTests()
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('withholds the reverse partial first snapshot', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    registryGetKeyMock
      .mockImplementationOnce(() => {
        throw new Error('machine registry unavailable')
      })
      .mockReturnValueOnce(registryPath('C:\\User'))
    __resetPersistedWindowsPathCacheForTests()

    try {
      expect(readPersistedWindowsPathSegments()).toEqual([])
    } finally {
      __resetPersistedWindowsPathCacheForTests()
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('does not duplicate an unresolved asynchronous refresh for a synchronous caller', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    registryGetKeyMock
      .mockReturnValueOnce(registryPath('C:\\Machine'))
      .mockImplementationOnce(() => {
        throw new Error('user registry unavailable')
      })
    __resetPersistedWindowsPathCacheForTests()

    try {
      const refresh = readPersistedWindowsPathSegmentsAsync()

      expect(readPersistedWindowsPathSegments()).toEqual([])
      await expect(refresh).resolves.toEqual([])
      expect(registryGetKeyMock).toHaveBeenCalledTimes(2)
    } finally {
      __resetPersistedWindowsPathCacheForTests()
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('does not let injected test reads populate production fallback state', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const execFileSync = vi
      .fn()
      .mockReturnValueOnce('    Path    REG_SZ    C:\\InjectedMachine\r\n')
      .mockReturnValueOnce('    Path    REG_SZ    C:\\InjectedUser\r\n')
    registryGetKeyMock.mockImplementation(() => {
      throw new Error('registry unavailable')
    })
    __resetPersistedWindowsPathCacheForTests()

    try {
      expect(readPersistedWindowsPathSegments({ platform: 'win32', execFileSync })).toEqual([
        'C:\\InjectedMachine',
        'C:\\InjectedUser'
      ])
      expect(readPersistedWindowsPathSegments()).toEqual([])
    } finally {
      __resetPersistedWindowsPathCacheForTests()
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('keeps the last good segments when a forced read hits a blocked registry', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    registryGetKeyMock
      .mockReturnValueOnce(registryPath('C:\\Machine'))
      .mockReturnValueOnce(registryPath('C:\\User'))
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
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('still clears the cache when the registry reports an empty Path', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    registryGetKeyMock
      .mockReturnValueOnce(registryPath('C:\\Machine'))
      .mockReturnValueOnce(registryPath('C:\\User'))
      .mockReturnValue(registryPath(''))
    __resetPersistedWindowsPathCacheForTests()

    try {
      expect(readPersistedWindowsPathSegments()).toEqual(['C:\\Machine', 'C:\\User'])

      // Why: an emptied persisted Path is a successful read, not a blocked one —
      // it must not be mistaken for the failure case and served from the cache.
      expect(readPersistedWindowsPathSegments({ forceRefresh: true })).toEqual([])
      expect(readPersistedWindowsPathSegments()).toEqual([])
    } finally {
      __resetPersistedWindowsPathCacheForTests()
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('does not resurrect a successfully emptied hive when the other hive fails', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    registryGetKeyMock
      .mockReturnValueOnce(registryPath('C:\\Machine'))
      .mockReturnValueOnce(registryPath('C:\\User'))
      .mockImplementationOnce(() => {
        throw new Error('machine registry unavailable')
      })
      .mockReturnValueOnce(registryPath(''))
      .mockImplementation(() => {
        throw new Error('registry unavailable')
      })
    __resetPersistedWindowsPathCacheForTests()

    try {
      expect(readPersistedWindowsPathSegments()).toEqual(['C:\\Machine', 'C:\\User'])
      invalidatePersistedWindowsPathCache()
      expect(readPersistedWindowsPathSegments()).toEqual(['C:\\Machine'])
      invalidatePersistedWindowsPathCache()
      expect(readPersistedWindowsPathSegments()).toEqual(['C:\\Machine'])
    } finally {
      __resetPersistedWindowsPathCacheForTests()
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('deduplicates concurrent forced asynchronous refreshes and merges each environment', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    registryGetKeyMock
      .mockReturnValueOnce(registryPath('C:\\Machine'))
      .mockReturnValueOnce(registryPath('C:\\User'))
    __resetPersistedWindowsPathCacheForTests()

    try {
      const firstEnv = { Path: 'C:\\First' }
      const secondEnv = { Path: 'C:\\Second' }
      const first = mergePersistedWindowsPathAsync(firstEnv, { forceRefresh: true })
      const second = mergePersistedWindowsPathAsync(secondEnv, { forceRefresh: true })

      await Promise.all([first, second])
      expect(firstEnv.Path).toBe('C:\\First;C:\\Machine;C:\\User')
      expect(secondEnv.Path).toBe('C:\\Second;C:\\Machine;C:\\User')
      expect(registryGetKeyMock).toHaveBeenCalledTimes(2)
    } finally {
      __resetPersistedWindowsPathCacheForTests()
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('keeps the last good cache when native registry reads fail', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    registryGetKeyMock
      .mockReturnValueOnce(registryPath('C:\\Machine'))
      .mockReturnValueOnce(registryPath('C:\\User'))
      .mockImplementation(() => {
        throw new Error('registry unavailable')
      })
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
      expect(registryGetKeyMock).toHaveBeenCalledTimes(2)
      await expect(readPersistedWindowsPathSegmentsAsync({ forceRefresh: true })).resolves.toEqual([
        'C:\\Machine',
        'C:\\User'
      ])
      await expect(readPersistedWindowsPathSegmentsAsync()).resolves.toEqual([
        'C:\\Machine',
        'C:\\User'
      ])
      expect(registryGetKeyMock).toHaveBeenCalledTimes(4)
    } finally {
      __resetPersistedWindowsPathCacheForTests()
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('does not let an older async read replace a newer synchronous refresh', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    registryGetKeyMock
      .mockReturnValueOnce(registryPath('C:\\OldMachine'))
      .mockReturnValueOnce(registryPath('C:\\OldUser'))
      .mockReturnValueOnce(registryPath('C:\\NewMachine'))
      .mockReturnValueOnce(registryPath('C:\\NewUser'))
    __resetPersistedWindowsPathCacheForTests()

    try {
      const olderRead = readPersistedWindowsPathSegmentsAsync({ forceRefresh: true })
      expect(readPersistedWindowsPathSegments({ forceRefresh: true })).toEqual([
        'C:\\NewMachine',
        'C:\\NewUser'
      ])

      await expect(olderRead).resolves.toEqual(['C:\\NewMachine', 'C:\\NewUser'])
      await expect(readPersistedWindowsPathSegmentsAsync()).resolves.toEqual([
        'C:\\NewMachine',
        'C:\\NewUser'
      ])
    } finally {
      __resetPersistedWindowsPathCacheForTests()
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('uses a current-generation refresh before merging an invalidated read', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    registryGetKeyMock
      .mockReturnValueOnce(registryPath('C:\\OldMachine'))
      .mockImplementationOnce(() => {
        queueMicrotask(invalidatePersistedWindowsPathCache)
        return registryPath('C:\\OldUser')
      })
      .mockReturnValueOnce(registryPath('C:\\NewMachine'))
      .mockReturnValueOnce(registryPath('C:\\NewUser'))
      .mockImplementation(() => {
        throw new Error('registry unavailable')
      })
    __resetPersistedWindowsPathCacheForTests()

    try {
      const env = { Path: 'C:\\Injected' }
      await mergePersistedWindowsPathAsync(env)

      expect(env.Path).toBe('C:\\Injected;C:\\NewMachine;C:\\NewUser')
      await expect(readPersistedWindowsPathSegmentsAsync()).resolves.toEqual([
        'C:\\NewMachine',
        'C:\\NewUser'
      ])
      invalidatePersistedWindowsPathCache()
      await expect(readPersistedWindowsPathSegmentsAsync()).resolves.toEqual([
        'C:\\NewMachine',
        'C:\\NewUser'
      ])
      expect(registryGetKeyMock).toHaveBeenCalledTimes(6)
    } finally {
      __resetPersistedWindowsPathCacheForTests()
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

  it('adopts persisted machine and user PATH ordering', () => {
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
      'C:\\Windows\\System32;C:\\Existing;C:\\Users\\me\\AppData\\Local\\Orca\\bin'
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

  it('reads the live host spelling when a path-less env inherits duplicate keys', () => {
    const execFileSync = vi
      .fn()
      .mockReturnValueOnce('    Path    REG_SZ    C:\\Machine\r\n')
      .mockReturnValueOnce('    Path    REG_SZ    C:\\User\r\n')
    const env: Record<string, string> = {}

    mergePersistedWindowsPath(env, {
      platform: 'win32',
      execFileSync,
      env: { ROOT: 'C:\\Root', Path: '%ROOT%\\Live', PATH: 'C:\\Shadowed' }
    })

    expect(env).toEqual({ Path: 'C:\\Root\\Live;C:\\Machine;C:\\User' })
  })

  it('stops an inherited WindowsApps alias from shadowing a newly installed Python', () => {
    const python = 'C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python314\\'
    const scripts = `${python}Scripts\\`
    const windowsApps = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps'
    const execFileSync = vi
      .fn()
      .mockReturnValueOnce('    Path    REG_EXPAND_SZ    C:\\Windows\\system32;C:\\Windows\r\n')
      .mockReturnValueOnce(`    Path    REG_EXPAND_SZ    ${python};${scripts};${windowsApps}\r\n`)
    const env = { Path: `C:\\Windows\\system32;C:\\Windows;${windowsApps}` }

    mergePersistedWindowsPath(env, { platform: 'win32', execFileSync })

    const segments = env.Path.split(';')
    expect(segments.indexOf(python)).toBeLessThan(segments.indexOf(windowsApps))
    expect(env.Path).toBe(`C:\\Windows\\system32;C:\\Windows;${python};${scripts};${windowsApps}`)
  })

  it('keeps injected entries ahead of the persisted PATH', () => {
    const injected = 'C:\\Users\\me\\AppData\\Local\\Orca\\resources\\bin'
    const python = 'C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python314\\'
    const windowsApps = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps'
    const execFileSync = vi
      .fn()
      .mockReturnValueOnce('    Path    REG_EXPAND_SZ    C:\\Windows\\system32\r\n')
      .mockReturnValueOnce(`    Path    REG_EXPAND_SZ    ${python};${windowsApps}\r\n`)
    const env = { Path: `${injected};C:\\Windows\\system32;${windowsApps}` }

    mergePersistedWindowsPath(env, { platform: 'win32', execFileSync })

    expect(env.Path).toBe(`${injected};C:\\Windows\\system32;${python};${windowsApps}`)
  })

  it('leaves the inherited PATH untouched when both registry reads are blocked', () => {
    const execFileSync = vi.fn().mockImplementation(() => {
      throw new Error('ERROR: Access is denied.')
    })
    const env = { Path: 'C:\\Windows\\system32;C:\\Existing' }

    mergePersistedWindowsPath(env, { platform: 'win32', execFileSync })

    expect(env.Path).toBe('C:\\Windows\\system32;C:\\Existing')
  })

  it('deduplicates segments that differ only by trailing separators', () => {
    const execFileSync = vi
      .fn()
      .mockReturnValueOnce('    Path    REG_SZ    C:\\Tools\r\n')
      .mockReturnValueOnce('    Path    REG_SZ    \r\n')
    const env = { Path: 'C:\\Tools\\' }

    mergePersistedWindowsPath(env, { platform: 'win32', execFileSync })

    expect(env.Path.split(';')).toEqual(['C:\\Tools'])
  })

  it('canonicalizes drive-root slash style and repetition for comparison', () => {
    const execFileSync = vi
      .fn()
      .mockReturnValueOnce('    Path    REG_SZ    C:\\\\\r\n')
      .mockReturnValueOnce('    Path    REG_SZ    \r\n')
    const env = { Path: 'C:/' }

    mergePersistedWindowsPath(env, { platform: 'win32', execFileSync })

    expect(env.Path.split(';')).toEqual(['C:\\\\'])
  })
})

describe('resolvePathEnvKey', () => {
  it('uses whichever Windows spelling is present on the env', () => {
    expect(resolvePathEnvKey({ Path: 'C:\\Windows' }, 'win32')).toBe('Path')
    expect(resolvePathEnvKey({ PATH: 'C:\\Windows' }, 'win32')).toBe('PATH')
    expect(resolvePathEnvKey({ path: 'C:\\Windows' }, 'win32')).toBe('path')
    expect(resolvePathEnvKey({ PaTh: 'C:\\Windows' }, 'win32')).toBe('PaTh')
  })

  // Why: Win32 returns the first case-insensitive match in the block, so a dual-cased env is
  // resolved by position; picking by casing would target the spelling the child never sees.
  it('resolves a dual-cased Windows env by block order, not casing', () => {
    expect(resolvePathEnvKey({ PATH: 'C:\\Live', Path: 'C:\\Shadowed' }, 'win32')).toBe('PATH')
    expect(resolvePathEnvKey({ Path: 'C:\\Live', PATH: 'C:\\Shadowed' }, 'win32')).toBe('Path')
  })

  it('skips a path key explicitly set to undefined', () => {
    expect(resolvePathEnvKey({ PATH: undefined, Path: 'C:\\Windows' }, 'win32')).toBe('Path')
  })

  it('falls back to the host block spelling for a Windows env with no path key', () => {
    // Why: a sparse patch that guesses wrong leaves the daemon's own merge holding both keys.
    expect(resolvePathEnvKey({}, 'win32', { PATH: 'C:\\Windows' })).toBe('PATH')
    expect(resolvePathEnvKey({}, 'win32', { Path: 'C:\\Windows' })).toBe('Path')
    expect(resolvePathEnvKey({}, 'win32', { Path: 'C:\\Live', PATH: 'C:\\Shadowed' })).toBe('Path')
    expect(resolvePathEnvKey({}, 'win32', {})).toBe('Path')
  })

  it('always resolves `PATH` off Windows so a POSIX `Path` variable is untouched', () => {
    expect(resolvePathEnvKey({ Path: '/decoy' }, 'linux')).toBe('PATH')
    expect(resolvePathEnvKey({ Path: '/decoy', PATH: '/usr/bin' }, 'darwin')).toBe('PATH')
  })
})
