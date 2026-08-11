import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Notifications from 'expo-notifications'
import {
  configureNotificationChannel,
  resetNotificationChannelConfigurationForTests
} from './local-notification-scheduling'

vi.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 'high' },
  setNotificationChannelAsync: vi.fn()
}))

vi.mock('react-native', () => ({ Platform: { OS: 'android', Version: 35 } }))

describe('Android notification channel configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetNotificationChannelConfigurationForTests()
  })

  it('configures the process-wide channel once across host subscriptions', async () => {
    configureNotificationChannel()
    configureNotificationChannel()
    await Promise.resolve()

    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledOnce()
  })

  it('retries on a later subscribe after the channel setup fails', async () => {
    vi.mocked(Notifications.setNotificationChannelAsync).mockRejectedValueOnce(
      new Error('channel unavailable')
    )
    configureNotificationChannel()
    // Why a macrotask: the rejection has to settle through .then and .catch before the
    // retry gate reopens, which outlasts a single microtask flush.
    await new Promise((resolve) => setTimeout(resolve, 0))

    configureNotificationChannel()
    await Promise.resolve()

    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledTimes(2)
  })
})
