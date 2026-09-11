import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readPushNotificationsPreference,
  savePushNotificationsEnabled
} from '../storage/preferences'
import { getNotificationPermissionState } from './mobile-notifications'
import { shouldPresentNotificationOptIn } from './notification-opt-in-gate'

vi.mock('../storage/preferences', () => ({
  readPushNotificationsPreference: vi.fn(),
  savePushNotificationsEnabled: vi.fn()
}))

vi.mock('./mobile-notifications', () => ({
  getNotificationPermissionState: vi.fn()
}))

describe('notification opt-in gate', () => {
  beforeEach(() => {
    vi.mocked(readPushNotificationsPreference).mockReset()
    vi.mocked(savePushNotificationsEnabled).mockReset()
    vi.mocked(getNotificationPermissionState).mockReset()
  })

  it('presents only when the local preference and system decision are both unset', async () => {
    vi.mocked(readPushNotificationsPreference).mockResolvedValue({ value: null, loaded: true })
    vi.mocked(getNotificationPermissionState).mockResolvedValue({
      granted: false,
      status: 'undetermined',
      canAskAgain: true,
      authorizationReflectsUserChoice: false
    })

    await expect(shouldPresentNotificationOptIn()).resolves.toBe(true)
    expect(savePushNotificationsEnabled).not.toHaveBeenCalled()
  })

  it.each([true, false])('preserves an existing %s mobile preference', async (value) => {
    vi.mocked(readPushNotificationsPreference).mockResolvedValue({ value, loaded: true })

    await expect(shouldPresentNotificationOptIn()).resolves.toBe(false)
    expect(getNotificationPermissionState).not.toHaveBeenCalled()
  })

  it('adopts existing system authorization without prompting', async () => {
    vi.mocked(readPushNotificationsPreference).mockResolvedValue({ value: null, loaded: true })
    vi.mocked(getNotificationPermissionState).mockResolvedValue({
      granted: true,
      status: 'granted',
      canAskAgain: true,
      authorizationReflectsUserChoice: true
    })

    await expect(shouldPresentNotificationOptIn()).resolves.toBe(false)
    expect(savePushNotificationsEnabled).toHaveBeenCalledWith(true)
  })

  it('still presents when a pre-Android 13 default grant is not an opt-in decision', async () => {
    vi.mocked(readPushNotificationsPreference).mockResolvedValue({ value: null, loaded: true })
    vi.mocked(getNotificationPermissionState).mockResolvedValue({
      granted: true,
      status: 'granted',
      canAskAgain: true,
      authorizationReflectsUserChoice: false
    })

    await expect(shouldPresentNotificationOptIn()).resolves.toBe(true)
    expect(savePushNotificationsEnabled).not.toHaveBeenCalled()
  })

  it('skips the gate when iOS has already denied permission', async () => {
    vi.mocked(readPushNotificationsPreference).mockResolvedValue({ value: null, loaded: true })
    vi.mocked(getNotificationPermissionState).mockResolvedValue({
      granted: false,
      status: 'denied',
      canAskAgain: false,
      authorizationReflectsUserChoice: false
    })

    await expect(shouldPresentNotificationOptIn()).resolves.toBe(false)
    expect(savePushNotificationsEnabled).toHaveBeenCalledWith(false)
  })

  it('does not block startup when storage or permission checks fail', async () => {
    vi.mocked(readPushNotificationsPreference).mockResolvedValue({ value: null, loaded: false })
    await expect(shouldPresentNotificationOptIn()).resolves.toBe(false)

    vi.mocked(readPushNotificationsPreference).mockResolvedValue({ value: null, loaded: true })
    vi.mocked(getNotificationPermissionState).mockRejectedValue(new Error('unavailable'))
    await expect(shouldPresentNotificationOptIn()).resolves.toBe(false)
  })
})
