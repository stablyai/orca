import { beforeEach, expect, it, vi } from 'vitest'
import { AppState } from 'react-native'
import {
  DEFAULT_NOTIFICATION_DELIVERY,
  loadNotificationDeliveryPreferences
} from './notification-delivery-preferences'
import {
  setNotificationViewingWorkspace,
  shouldSuppressNotificationWhileViewing
} from './notification-viewing-policy'

const storage = new Map<string, string>()
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null)
  }
}))
vi.mock('react-native', () => ({ AppState: { currentState: 'background' } }))
beforeEach(() => {
  storage.clear()
  setNotificationViewingWorkspace(null)
  AppState.currentState = 'background'
})

it('suppresses only the workspace being viewed on this phone, and never while backgrounded', async () => {
  const event = { source: 'terminal-bell', worktreeId: 'folder-id' }
  setNotificationViewingWorkspace({ hostId: 'ssh-host', worktreeId: 'folder-id' })
  AppState.currentState = 'active'
  expect(await shouldSuppressNotificationWhileViewing(event, 'ssh-host', true)).toBe(true)
  expect(await shouldSuppressNotificationWhileViewing(event, 'another-host', true)).toBe(false)
  expect(
    await shouldSuppressNotificationWhileViewing(
      { ...event, worktreeId: 'other' },
      'ssh-host',
      true
    )
  ).toBe(false)
  AppState.currentState = 'background'
  expect(await shouldSuppressNotificationWhileViewing(event, 'ssh-host', true)).toBe(false)
})

it('recovers defaults from malformed stored preferences', async () => {
  storage.set('orca:notificationDeliveryPreferences', '{broken')
  expect(await loadNotificationDeliveryPreferences()).toEqual(DEFAULT_NOTIFICATION_DELIVERY)
})
