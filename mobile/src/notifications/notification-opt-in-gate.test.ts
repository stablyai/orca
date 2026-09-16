import { describe, expect, it, vi } from 'vitest'
import { readPushNotificationsPreference } from '../storage/preferences'
import { shouldPresentNotificationOptIn } from './notification-opt-in-gate'

vi.mock('../storage/preferences', () => ({
  readPushNotificationsPreference: vi.fn()
}))

describe('notification opt-in gate', () => {
  it('asks for push-service consent when no choice is saved, regardless of OS permission', async () => {
    vi.mocked(readPushNotificationsPreference).mockResolvedValue({ value: null, loaded: true })
    await expect(shouldPresentNotificationOptIn()).resolves.toBe(true)
  })

  it.each([true, false])('does not ask again after choosing %s', async (value) => {
    vi.mocked(readPushNotificationsPreference).mockResolvedValue({ value, loaded: true })
    await expect(shouldPresentNotificationOptIn()).resolves.toBe(false)
  })

  it('does not prompt when the saved choice cannot be read', async () => {
    vi.mocked(readPushNotificationsPreference).mockResolvedValue({ value: null, loaded: false })
    await expect(shouldPresentNotificationOptIn()).resolves.toBe(false)
  })
})
