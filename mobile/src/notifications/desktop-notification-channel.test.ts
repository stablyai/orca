import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import { ensureDesktopNotificationChannel } from './desktop-notification-channel'

vi.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 'high' },
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
  it('creates the channel the gateway payload names', async () => {
    await ensureDesktopNotificationChannel()

    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith(
      'orca-desktop',
      expect.objectContaining({ importance: 'high' })
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
