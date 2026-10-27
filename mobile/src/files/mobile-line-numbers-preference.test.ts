import { describe, expect, it, vi } from 'vitest'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  MOBILE_FILE_PREVIEW_LINE_NUMBERS_STORAGE_KEY,
  parseMobileLineNumbersPreference,
  readMobileLineNumbersPreference,
  writeMobileLineNumbersPreference
} from './mobile-line-numbers-preference'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn()
  }
}))

describe('mobile-line-numbers-preference', () => {
  it('defaults to true when no stored value exists', () => {
    expect(parseMobileLineNumbersPreference(null)).toBe(true)
  })

  it('parses stored boolean strings correctly', () => {
    expect(parseMobileLineNumbersPreference('true')).toBe(true)
    expect(parseMobileLineNumbersPreference('false')).toBe(false)
    expect(parseMobileLineNumbersPreference('anything-else')).toBe(false)
  })

  it('reads preference from AsyncStorage', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValueOnce('false')
    const value = await readMobileLineNumbersPreference()
    expect(value).toBe(false)
    expect(AsyncStorage.getItem).toHaveBeenCalledWith(
      MOBILE_FILE_PREVIEW_LINE_NUMBERS_STORAGE_KEY
    )
  })

  it('falls back to true on storage read failure', async () => {
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('Storage unavailable'))
    const value = await readMobileLineNumbersPreference()
    expect(value).toBe(true)
  })

  it('writes preference to AsyncStorage', async () => {
    vi.mocked(AsyncStorage.setItem).mockResolvedValueOnce(undefined)
    await writeMobileLineNumbersPreference(false)
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      MOBILE_FILE_PREVIEW_LINE_NUMBERS_STORAGE_KEY,
      'false'
    )
  })
})
