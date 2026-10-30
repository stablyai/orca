import { beforeEach, describe, expect, it, vi } from 'vitest'

const asyncStorageMock = vi.hoisted(() => ({
  values: new Map<string, string>(),
  getItem: vi.fn<(key: string) => Promise<string | null>>(),
  setItem: vi.fn<(key: string, value: string) => Promise<void>>()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: asyncStorageMock
}))

import { normalizeHostAppVersion } from './host-app-version'
import { loadHostAppVersion, recordHostAppVersion } from './host-app-version-store'

describe('host app version store', () => {
  beforeEach(() => {
    asyncStorageMock.values.clear()
    asyncStorageMock.getItem.mockReset().mockImplementation(async (key) => {
      return asyncStorageMock.values.get(key) ?? null
    })
    asyncStorageMock.setItem.mockReset().mockImplementation(async (key, value) => {
      asyncStorageMock.values.set(key, value)
    })
  })

  it('persists a bounded version once per host', async () => {
    await recordHostAppVersion('host-1', ' 1.4.191 ')
    await recordHostAppVersion('host-1', '1.4.191')
    await recordHostAppVersion('host-2', '1.4.188')

    await expect(loadHostAppVersion('host-1')).resolves.toBe('1.4.191')
    await expect(loadHostAppVersion('host-2')).resolves.toBe('1.4.188')

    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(2)
    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      'orca:host-app-version:v1:host-1',
      '1.4.191'
    )
    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      'orca:host-app-version:v1:host-2',
      '1.4.188'
    )
  })

  it('loads a previously observed version without requiring a live host', async () => {
    asyncStorageMock.values.set('orca:host-app-version:v1:host-1', '1.4.188')

    await expect(loadHostAppVersion('host-1')).resolves.toBe('1.4.188')
    await expect(loadHostAppVersion('host-2')).resolves.toBeNull()
    expect(asyncStorageMock.setItem).not.toHaveBeenCalled()
  })

  it('rejects multiline, empty, and oversized host-provided values', async () => {
    for (const value of ['1.4.191\nInjected: value', '   ', 'x'.repeat(65)]) {
      expect(normalizeHostAppVersion(value)).toBeNull()
      await recordHostAppVersion('host-1', value)
    }
    expect(asyncStorageMock.getItem).not.toHaveBeenCalled()
    expect(asyncStorageMock.setItem).not.toHaveBeenCalled()
  })
})
