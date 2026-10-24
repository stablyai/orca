import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import {
  COMPLETE_VIBRATION_PATTERN,
  DESKTOP_NOTIFICATION_COMPLETE_CHANNEL_ID,
  DESKTOP_NOTIFICATION_URGENT_CHANNEL_ID,
  URGENT_VIBRATION_PATTERN,
  ensureDesktopNotificationChannel
} from './desktop-notification-channel'

vi.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 'high', MAX: 'max' },
  setNotificationChannelAsync: vi.fn()
}))

vi.mock('react-native', () => ({
  AppState: { currentState: 'background' },
  Platform: { OS: 'android' }
}))

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(Platform, { OS: 'android' })
  vi.mocked(Notifications.setNotificationChannelAsync).mockResolvedValue(null as never)
})

describe('ensureDesktopNotificationChannel', () => {
  it('creates the channel the gateway payload names plus urgent and complete channels', async () => {
    await ensureDesktopNotificationChannel()

    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith(
      'orca-desktop',
      expect.objectContaining({
        importance: 'max',
        vibrationPattern: COMPLETE_VIBRATION_PATTERN
      })
    )
    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith(
      DESKTOP_NOTIFICATION_URGENT_CHANNEL_ID,
      expect.objectContaining({
        importance: 'max',
        vibrationPattern: URGENT_VIBRATION_PATTERN,
        lightColor: '#f59e0b'
      })
    )
    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith(
      DESKTOP_NOTIFICATION_COMPLETE_CHANNEL_ID,
      expect.objectContaining({
        importance: 'max',
        vibrationPattern: COMPLETE_VIBRATION_PATTERN,
        lightColor: '#10b981'
      })
    )
  })

  it('does nothing on iOS, which has no notification channels', () => {
    Object.assign(Platform, { OS: 'ios' })

    ensureDesktopNotificationChannel()

    expect(Notifications.setNotificationChannelAsync).not.toHaveBeenCalled()
  })

  it('reports channel failure so registration can retry', async () => {
    vi.mocked(Notifications.setNotificationChannelAsync).mockRejectedValue(new Error('no channels'))

    await expect(ensureDesktopNotificationChannel()).rejects.toThrow('no channels')
  })
})
