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
  readPersistedWindowsPathSegmentsAsync
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
