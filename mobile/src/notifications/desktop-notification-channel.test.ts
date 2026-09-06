import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import {
  DESKTOP_NOTIFICATION_CHANNEL_ID,
  ensureDesktopNotificationChannel
} from './desktop-notification-channel'

vi.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 'high' },
  setNotificationChannelAsync: vi.fn()
}))

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }))

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(Platform, { OS: 'android' })
  vi.mocked(Notifications.setNotificationChannelAsync).mockResolvedValue(null as never)
})

describe('ensureDesktopNotificationChannel', () => {
  it('creates the channel the gateway payload names', () => {
    ensureDesktopNotificationChannel()

    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith(
      'orca-desktop',
      expect.objectContaining({ importance: 'high' })
    )
    expect(DESKTOP_NOTIFICATION_CHANNEL_ID).toBe('orca-desktop')
  })

  it('does nothing on iOS, which has no notification channels', () => {
    Object.assign(Platform, { OS: 'ios' })

    ensureDesktopNotificationChannel()

    expect(Notifications.setNotificationChannelAsync).not.toHaveBeenCalled()
  })

  it('survives a shell whose channel API rejects', () => {
    vi.mocked(Notifications.setNotificationChannelAsync).mockRejectedValue(new Error('no channels'))

    expect(() => ensureDesktopNotificationChannel()).not.toThrow()
  })
})

describe('app boot', () => {
  it('creates the channel at startup, not only once a socket subscribes', () => {
    // A background push can be the first thing to target 'orca-desktop', and Android
    // drops a notification whose channel does not exist. Asserted against the source
    // because vitest only collects src/, so app/_layout.tsx has no runtime coverage.
    const layout = readFileSync(new URL('../../app/_layout.tsx', import.meta.url), 'utf8')

    expect(layout).toContain("from '../src/notifications/desktop-notification-channel'")
    expect(layout).toMatch(/^ensureDesktopNotificationChannel\(\)$/m)
  })
})
