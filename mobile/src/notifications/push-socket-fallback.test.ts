import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotificationDeliveryPreferences } from './notification-delivery-preferences'
import { deriveHostFingerprint } from './push-host-fingerprint'
import {
  presentSocketNotificationFallback,
  sendLocalNotificationDisplayTest
} from './push-socket-fallback'
import type { DesktopNotificationDispatchEvent } from './desktop-notification-events'

const publicKeyB64 = Buffer.alloc(32, 3).toString('base64')
const mocks = vi.hoisted(() => ({
  registered: vi.fn(async () => false),
  enabled: vi.fn(async () => true),
  preferences: vi.fn(async (): Promise<NotificationDeliveryPreferences> => ({
    onlyWhenDesktopAway: false,
    sound: true,
    suppressWhileViewing: true
  })),
  catalog: vi.fn(async (): Promise<{ id: string; publicKeyB64: string }[]> => []),
  eligible: vi.fn(async () => true),
  schedule: vi.fn(async () => 'scheduled-1'),
  setChannel: vi.fn(async () => null),
  platform: { OS: 'android' }
}))

vi.mock('./push-registration', () => ({ isHostPushRegistered: mocks.registered }))
vi.mock('../storage/preferences', () => ({ loadPushNotificationsEnabled: mocks.enabled }))
vi.mock('./notification-delivery-preferences', () => ({
  loadNotificationDeliveryPreferences: mocks.preferences
}))
vi.mock('../transport/host-store', () => ({ loadHostCatalog: mocks.catalog }))
vi.mock('./push-receive', () => ({ canPresentForegroundPush: mocks.eligible }))
vi.mock('expo-notifications', () => ({
  scheduleNotificationAsync: mocks.schedule,
  setNotificationChannelAsync: mocks.setChannel,
  AndroidImportance: { HIGH: 4 }
}))
vi.mock('react-native', () => ({ Platform: mocks.platform }))

const enabledPreferences = (
  overrides: Partial<NotificationDeliveryPreferences> = {}
): NotificationDeliveryPreferences => ({
  onlyWhenDesktopAway: false,
  sound: true,
  suppressWhileViewing: true,
  ...overrides
})

const alert = (
  overrides: Partial<DesktopNotificationDispatchEvent> = {}
): DesktopNotificationDispatchEvent => ({
  type: 'notification',
  title: '  Needs input  ',
  body: '  Reply in the workspace  ',
  notificationId: 'agent-1',
  notificationSeq: 7,
  notificationEpoch: 'epoch-1',
  worktreeId: 'wt-1',
  executionHost: 'exec-1',
  paneKey: 'pane-1',
  ...overrides
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.registered.mockResolvedValue(false)
  mocks.enabled.mockResolvedValue(true)
  mocks.preferences.mockResolvedValue(enabledPreferences())
  mocks.catalog.mockResolvedValue([{ id: 'host-1', publicKeyB64 }])
  mocks.eligible.mockResolvedValue(true)
  mocks.schedule.mockResolvedValue('scheduled-1')
  mocks.setChannel.mockResolvedValue(null)
  mocks.platform.OS = 'android'
})

describe('presentSocketNotificationFallback', () => {
  it('schedules a local alert when remote push is not registered', async () => {
    const hostFingerprint = deriveHostFingerprint(publicKeyB64)
    await presentSocketNotificationFallback(alert(), 'host-1')
    expect(mocks.schedule).toHaveBeenCalledWith({
      identifier: `${hostFingerprint}:agent-1`,
      content: {
        title: 'Needs input',
        body: 'Reply in the workspace',
        data: {
          hostId: 'host-1',
          kind: 'alert',
          hostFingerprint,
          notificationId: 'agent-1',
          notificationSeq: 7,
          notificationEpoch: 'epoch-1',
          paneKey: 'pane-1',
          worktreeId: 'wt-1',
          executionHost: 'exec-1'
        },
        sound: 'default'
      },
      trigger: { channelId: 'orca-desktop' }
    })
  })

  it('uses the silent channel when sound is off', async () => {
    mocks.preferences.mockResolvedValue(enabledPreferences({ sound: false }))
    await presentSocketNotificationFallback(alert(), 'host-1')
    expect(mocks.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ sound: false }),
        trigger: { channelId: 'orca-desktop-silent' }
      })
    )
  })

  it('does not schedule when remote push is already registered for the host', async () => {
    mocks.registered.mockResolvedValue(true)
    await presentSocketNotificationFallback(alert(), 'host-1')
    expect(mocks.schedule).not.toHaveBeenCalled()
  })

  it.each([{ desktopAllowed: false }, { legacySocketAllowed: false }] as const)(
    'does not schedule when the desktop blocks socket delivery %j',
    async (policy) => {
      await presentSocketNotificationFallback(alert(policy), 'host-1')
      expect(mocks.schedule).not.toHaveBeenCalled()
    }
  )

  it('honors only-when-desktop-away without blocking alerts the preference allows', async () => {
    mocks.preferences.mockResolvedValue(enabledPreferences({ onlyWhenDesktopAway: true }))
    await presentSocketNotificationFallback(alert({ desktopAway: false }), 'host-1')
    expect(mocks.schedule).not.toHaveBeenCalled()

    mocks.preferences.mockResolvedValue(enabledPreferences({ onlyWhenDesktopAway: false }))
    await presentSocketNotificationFallback(alert({ desktopAway: false }), 'host-1')
    expect(mocks.schedule).toHaveBeenCalledOnce()
  })

  it('does not schedule when foreground policy refuses or the subscription is gone', async () => {
    mocks.eligible.mockResolvedValue(false)
    await presentSocketNotificationFallback(alert(), 'host-1')
    expect(mocks.schedule).not.toHaveBeenCalled()

    mocks.eligible.mockImplementation(async () => {
      return true
    })
    await presentSocketNotificationFallback(alert(), 'host-1', () => true)
    expect(mocks.schedule).not.toHaveBeenCalled()
  })

  it('does not schedule when eligibility flips the subscription to disposed', async () => {
    let disposed = false
    mocks.eligible.mockImplementation(async () => {
      disposed = true
      return true
    })
    await presentSocketNotificationFallback(alert(), 'host-1', () => disposed)
    expect(mocks.schedule).not.toHaveBeenCalled()
  })

  it('does not schedule a banner with no title and no body', async () => {
    await presentSocketNotificationFallback(alert({ title: '   ', body: '' }), 'host-1')
    expect(mocks.schedule).not.toHaveBeenCalled()
  })

  it('does not schedule when push notifications are disabled', async () => {
    mocks.enabled.mockResolvedValue(false)
    await presentSocketNotificationFallback(alert(), 'host-1')
    expect(mocks.schedule).not.toHaveBeenCalled()
  })
})

describe('sendLocalNotificationDisplayTest', () => {
  it.each([
    {
      os: 'android',
      sound: true,
      soundValue: 'default' as const,
      trigger: { channelId: 'orca-desktop' }
    },
    {
      os: 'android',
      sound: false,
      soundValue: false as const,
      trigger: { channelId: 'orca-desktop-silent' }
    },
    { os: 'ios', sound: true, soundValue: 'default' as const, trigger: null }
  ])('schedules on $os with sound=$sound', async ({ os, sound, soundValue, trigger }) => {
    mocks.platform.OS = os
    mocks.preferences.mockResolvedValue(enabledPreferences({ sound }))
    await sendLocalNotificationDisplayTest()
    expect(mocks.schedule).toHaveBeenCalledWith({
      content: {
        title: 'Orca',
        body: 'Test notification from Orca.',
        sound: soundValue
      },
      trigger
    })
  })
})
