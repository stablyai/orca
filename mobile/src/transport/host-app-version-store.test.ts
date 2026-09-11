import { beforeEach, describe, expect, it, vi } from 'vitest'

const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: asyncStorageMock
}))

import {
  loadHostAppVersion,
  normalizeHostAppVersion,
  recordHostAppVersion
} from './host-app-version-store'

describe('host app version store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    asyncStorageMock.getItem.mockResolvedValue(null)
    asyncStorageMock.setItem.mockResolvedValue(undefined)
  })

  it('persists a bounded version once per host', async () => {
    asyncStorageMock.getItem.mockResolvedValueOnce(null).mockResolvedValueOnce('1.4.191')

    await recordHostAppVersion('host-1', ' 1.4.191 ')
    await recordHostAppVersion('host-1', '1.4.191')

    expect(asyncStorageMock.setItem).toHaveBeenCalledOnce()
    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      'orca:host-app-version:v1:host-1',
      '1.4.191'
    )
  })

  it('loads a previously observed version without requiring a live host', async () => {
    asyncStorageMock.getItem.mockResolvedValue('1.4.188')

    await expect(loadHostAppVersion('host-1')).resolves.toBe('1.4.188')
  })

  it('rejects multiline, empty, and oversized host-provided values', async () => {
    expect(normalizeHostAppVersion('1.4.191\nInjected: value')).toBeNull()
    expect(normalizeHostAppVersion('   ')).toBeNull()
    expect(normalizeHostAppVersion('x'.repeat(65))).toBeNull()

    await recordHostAppVersion('host-1', '1.4.191\nInjected: value')
    expect(asyncStorageMock.setItem).not.toHaveBeenCalled()
  })
})
