import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TRUE_BLACK_STORAGE_KEY,
  readTrueBlackPreference,
  saveTrueBlackPreference
} from './true-black-preference'

const secureStoreMock = vi.hoisted(() => ({
  getItem: vi.fn<(key: string) => string | null>(),
  setItem: vi.fn<(key: string, value: string) => void>()
}))

// Getters so per-test reassignment (including removing getItem for web) reaches the module.
vi.mock('expo-secure-store', () => ({
  get getItem() {
    return secureStoreMock.getItem
  },
  get setItem() {
    return secureStoreMock.setItem
  }
}))

describe('true black preference', () => {
  beforeEach(() => {
    secureStoreMock.getItem = vi.fn<(key: string) => string | null>()
    secureStoreMock.setItem = vi.fn<(key: string, value: string) => void>()
  })

  it('reads true only for the stored string "true"', () => {
    secureStoreMock.getItem.mockReturnValue('true')
    expect(readTrueBlackPreference()).toBe(true)
    secureStoreMock.getItem.mockReturnValue('True')
    expect(readTrueBlackPreference()).toBe(false)
  })

  it('treats null, "false" and a throwing getItem as false', () => {
    secureStoreMock.getItem.mockReturnValue(null)
    expect(readTrueBlackPreference()).toBe(false)
    secureStoreMock.getItem.mockReturnValue('false')
    expect(readTrueBlackPreference()).toBe(false)
    secureStoreMock.getItem.mockImplementation(() => {
      throw new Error('storage broken')
    })
    expect(readTrueBlackPreference()).toBe(false)
  })

  it('reads false instead of throwing when getItem is missing (web)', () => {
    Reflect.deleteProperty(secureStoreMock, 'getItem')
    expect(readTrueBlackPreference()).toBe(false)
  })

  it('saves "true"/"false" under the storage key', () => {
    saveTrueBlackPreference(true)
    expect(secureStoreMock.setItem).toHaveBeenCalledWith(TRUE_BLACK_STORAGE_KEY, 'true')
    saveTrueBlackPreference(false)
    expect(secureStoreMock.setItem).toHaveBeenCalledWith(TRUE_BLACK_STORAGE_KEY, 'false')
  })

  it('does not throw when setItem throws', () => {
    secureStoreMock.setItem.mockImplementation(() => {
      throw new Error('storage broken')
    })
    expect(() => saveTrueBlackPreference(true)).not.toThrow()
  })
})
