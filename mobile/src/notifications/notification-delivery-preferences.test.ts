import { beforeEach, expect, it, vi } from 'vitest'
import { AppState } from 'react-native'
import {
  DEFAULT_NOTIFICATION_DELIVERY,
  loadNotificationDeliveryPreferences,
  notificationPreferencesFilter,
  saveNotificationDeliveryPreferences
} from './notification-delivery-preferences'
import {
  getCurrentInAppNotificationBanner,
  publishInAppNotificationBanner,
  resetInAppNotificationBannerForTests
} from './in-app-notification-banner-store'
import {
  isViewingWorkspaceTarget,
  setInPageNotificationViewingWorkspace,
  setNotificationViewingWorkspace,
  shouldSuppressNotificationWhileViewing
} from './notification-viewing-policy'

const storage = new Map<string, string>()
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.set(key, value)
    })
  }
}))
vi.mock('react-native', () => ({ AppState: { currentState: 'background' } }))
beforeEach(() => {
  storage.clear()
  resetInAppNotificationBannerForTests()
  setNotificationViewingWorkspace(null)
  AppState.currentState = 'background'
})

it('persists only phone-specific delivery preferences', async () => {
  expect(await loadNotificationDeliveryPreferences()).toEqual(DEFAULT_NOTIFICATION_DELIVERY)
  const value = {
    ...DEFAULT_NOTIFICATION_DELIVERY,
    onlyWhenDesktopAway: false,
    sound: false
  }
  await saveNotificationDeliveryPreferences(value)
  expect(await loadNotificationDeliveryPreferences()).toEqual(value)
  expect(notificationPreferencesFilter(value)).toEqual({
    onlyWhenDesktopAway: false,
    sound: false
  })
})

it('ignores unrelated stored preferences', async () => {
  storage.set(
    'orca:notificationDeliveryPreferences',
    JSON.stringify({
      onlyWhenDesktopAway: false,
      sound: false,
      suppressWhileViewing: false,
      unrelatedSetting: false
    })
  )
  expect(await loadNotificationDeliveryPreferences()).toEqual({
    onlyWhenDesktopAway: false,
    sound: false,
    suppressWhileViewing: false
  })
  expect(notificationPreferencesFilter(await loadNotificationDeliveryPreferences())).toEqual({
    onlyWhenDesktopAway: false,
    sound: false
  })
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

it('suppresses notifications when viewing a workspace in-page on the host route and matches URL-encoded params', () => {
  AppState.currentState = 'active'
  const worktreeId = 'D:\\code\\orca::D:\\code\\orca'
  setInPageNotificationViewingWorkspace({
    hostId: 'host-1',
    worktreeId
  })
  setNotificationViewingWorkspace(null, { preserveInPageForHostId: 'host-1' })

  expect(shouldSuppressNotificationWhileViewing({ worktreeId }, 'host-1', true)).toBe(true)
  expect(
    isViewingWorkspaceTarget({
      hostId: 'host-1',
      worktreeId
    })
  ).toBe(true)

  // Leaving the host clears the in-page viewing state.
  setNotificationViewingWorkspace(null)
  expect(shouldSuppressNotificationWhileViewing({ worktreeId }, 'host-1', true)).toBe(false)

  // URL-encoded native route params still match decoded event worktreeId.
  setNotificationViewingWorkspace({
    hostId: encodeURIComponent('host-1'),
    worktreeId: encodeURIComponent(worktreeId)
  })
  expect(shouldSuppressNotificationWhileViewing({ worktreeId }, 'host-1', true)).toBe(true)
})

it('auto-dismisses an active in-app banner when entering the workspace it targets', () => {
  publishInAppNotificationBanner({
    id: 'banner-1',
    tone: 'complete',
    hostId: 'host-1',
    hostName: 'Desktop',
    title: 'Orca',
    body: 'Finished',
    worktreeId: 'wt-1',
    createdAt: 100
  })
  expect(getCurrentInAppNotificationBanner()?.id).toBe('banner-1')

  setInPageNotificationViewingWorkspace({ hostId: 'host-1', worktreeId: 'wt-2' })
  expect(getCurrentInAppNotificationBanner()?.id).toBe('banner-1')

  setInPageNotificationViewingWorkspace({ hostId: 'host-1', worktreeId: 'wt-1' })
  expect(getCurrentInAppNotificationBanner()).toBeNull()
})

it('recovers defaults from malformed stored preferences', async () => {
  storage.set('orca:notificationDeliveryPreferences', '{broken')
  expect(await loadNotificationDeliveryPreferences()).toEqual(DEFAULT_NOTIFICATION_DELIVERY)
})
