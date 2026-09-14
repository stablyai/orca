import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getMobileHardwareKeyboardPreferences,
  loadMobileHardwareKeyboardPreferences,
  saveMobileTerminalShortcutPolicy,
  subscribeMobileHardwareKeyboardPreferences
} from './mobile-hardware-keyboard-preferences'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn()
  }
}))

describe('mobile hardware keyboard preferences', () => {
  beforeEach(() => {
    vi.mocked(AsyncStorage.getItem).mockReset().mockResolvedValue(null)
    vi.mocked(AsyncStorage.setItem).mockReset()
  })

  it('publishes a policy only after it is persisted', async () => {
    await loadMobileHardwareKeyboardPreferences()
    const listener = vi.fn()
    const unsubscribe = subscribeMobileHardwareKeyboardPreferences(listener)
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('storage unavailable'))

    await expect(saveMobileTerminalShortcutPolicy('terminal-first')).rejects.toThrow(
      'storage unavailable'
    )

    expect(getMobileHardwareKeyboardPreferences().terminalShortcutPolicy).toBe('orca-first')
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })
})
