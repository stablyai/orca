import { describe, expect, it } from 'vitest'
import { getDefaultNotificationSettings } from '../../../shared/notification-settings-defaults'
import {
  normalizeNotificationSettings,
  persistedNotificationSettingsRepaired
} from './onboarding-normalization'

describe('child workspace unread notification preference', () => {
  it('defaults on for new and older profiles', () => {
    expect(getDefaultNotificationSettings().showChildWorktreeUnread).toBe(true)
    expect(normalizeNotificationSettings({ enabled: false }).showChildWorktreeUnread).toBe(true)
    expect(normalizeNotificationSettings(undefined).showChildWorktreeUnread).toBe(true)
  })

  it('preserves explicit opt-out independently of native notifications', () => {
    const settings = {
      ...getDefaultNotificationSettings(),
      enabled: false,
      showChildWorktreeUnread: false
    }
    expect(normalizeNotificationSettings(settings)).toEqual(settings)
    expect(
      persistedNotificationSettingsRepaired(settings, normalizeNotificationSettings(settings))
    ).toBe(false)
  })

  it.each([null, 'false', 0])('repairs invalid value %s to the default', (value) => {
    const settings = { ...getDefaultNotificationSettings(), showChildWorktreeUnread: value }
    const normalized = normalizeNotificationSettings(settings)
    expect(normalized.showChildWorktreeUnread).toBe(true)
    expect(persistedNotificationSettingsRepaired(settings, normalized)).toBe(true)
  })
})
