import { describe, expect, it, vi } from 'vitest'
import { subscribeToDesktopNotifications } from './mobile-notifications'
import type { RpcClient } from '../transport/rpc-client'

vi.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 'high' },
  setNotificationChannelAsync: vi.fn(),
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  scheduleNotificationAsync: vi.fn()
}))

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' }
}))

vi.mock('../storage/preferences', () => ({
  loadPushNotificationsEnabled: vi.fn()
}))

describe('subscribeToDesktopNotifications', () => {
  it('drops the local stream when disposed before the desktop returns ready', () => {
    const unsubscribeStream = vi.fn()
    const client = {
      subscribe: vi.fn(() => unsubscribeStream),
      getState: vi.fn(() => 'connected'),
      sendRequest: vi.fn()
    } as unknown as RpcClient

    const unsubscribe = subscribeToDesktopNotifications(client, 'host-1')
    unsubscribe()

    expect(unsubscribeStream).toHaveBeenCalledTimes(1)
    expect(client.sendRequest).not.toHaveBeenCalled()
  })
})
