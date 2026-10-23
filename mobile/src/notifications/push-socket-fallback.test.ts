import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COMPLETE_VIBRATION_PATTERN,
  URGENT_VIBRATION_PATTERN
} from './desktop-notification-channel'
import {
  getCurrentInAppNotificationBanner,
  resetInAppNotificationBannerForTests
} from './in-app-notification-banner-store'
import type { NotificationDeliveryPreferences } from './notification-delivery-preferences'
import { deriveHostFingerprint } from './push-host-fingerprint'
import {
  classifyNotificationTone,
  presentSocketNotificationFallback,
  resolveEventPaneKey,
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
  catalog: vi.fn(async (): Promise<{ id: string; name?: string; publicKeyB64: string }[]> => []),
  eligible: vi.fn(async () => true),
  dismissed: vi.fn(async () => false),
  schedule: vi.fn(async () => 'scheduled-1'),
  setChannel: vi.fn(async () => null),
  appState: { currentState: 'active' },
  platform: { OS: 'android' }
}))

vi.mock('./push-registration', () => ({ isHostPushRegistered: mocks.registered }))
vi.mock('../storage/preferences', () => ({ loadPushNotificationsEnabled: mocks.enabled }))
vi.mock('./notification-delivery-preferences', () => ({
  loadNotificationDeliveryPreferences: mocks.preferences
}))
vi.mock('../transport/host-store', () => ({ loadHostCatalog: mocks.catalog }))
vi.mock('./push-receive', () => ({ canPresentForegroundPush: mocks.eligible }))
vi.mock('./push-dismissal-watermarks', () => ({ wasPushDismissed: mocks.dismissed }))
vi.mock('expo-notifications', () => ({
  scheduleNotificationAsync: mocks.schedule,
  setNotificationChannelAsync: mocks.setChannel,
  AndroidImportance: { HIGH: 4, MAX: 5 }
}))
vi.mock('react-native', () => ({
  AppState: mocks.appState,
  Platform: mocks.platform
}))

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
  resetInAppNotificationBannerForTests()
  mocks.registered.mockResolvedValue(false)
  mocks.enabled.mockResolvedValue(true)
  mocks.preferences.mockResolvedValue(enabledPreferences())
  mocks.catalog.mockResolvedValue([{ id: 'host-1', name: 'Work Laptop', publicKeyB64 }])
  mocks.eligible.mockResolvedValue(true)
  mocks.dismissed.mockResolvedValue(false)
  mocks.schedule.mockResolvedValue('scheduled-1')
  mocks.setChannel.mockResolvedValue(null)
  mocks.appState.currentState = 'active'
  mocks.platform.OS = 'android'
})

describe('classifyNotificationTone & resolveEventPaneKey', () => {
  it('classifies urgent vs complete notifications accurately', () => {
    expect(classifyNotificationTone({ agentState: 'waiting', title: 'orca' })).toBe('urgent')
    expect(classifyNotificationTone({ agentState: 'blocked', title: 'orca' })).toBe('urgent')
    expect(classifyNotificationTone({ source: 'terminal-bell', title: 'orca' })).toBe('urgent')
    expect(classifyNotificationTone({ agentState: 'done', title: 'orca' })).toBe('complete')
    expect(
      classifyNotificationTone({ title: 'orca · main', body: 'Claude finished the task' })
    ).toBe('complete')
  })

  it('extracts paneKey from agent notificationId when paneKey is omitted', () => {
    expect(
      resolveEventPaneKey({
        notificationId: 'agent:wt%2F1:tab-1%3Aleaf-2:1700000000'
      })
    ).toBe('tab-1:leaf-2')
  })
})

describe('presentSocketNotificationFallback', () => {
  it('schedules a distinctive urgent alert and publishes an in-app banner when active', async () => {
    const hostFingerprint = deriveHostFingerprint(publicKeyB64)
    await presentSocketNotificationFallback(alert({ agentState: 'waiting' }), 'host-1')
    expect(mocks.schedule).toHaveBeenCalledWith({
      identifier: `${hostFingerprint}:agent-1`,
      content: {
        title: '⚡ Needs input',
        subtitle: 'Work Laptop · Needs input',
        body: 'Reply in the workspace',
        color: '#f59e0b',
        vibrate: URGENT_VIBRATION_PATTERN,
        priority: 'max',
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
      trigger: { channelId: 'orca-desktop-urgent' }
    })
    expect(getCurrentInAppNotificationBanner()).toEqual(
      expect.objectContaining({
        tone: 'urgent',
        hostId: 'host-1',
        hostName: 'Work Laptop',
        title: 'Needs input',
        body: 'Reply in the workspace',
        worktreeId: 'wt-1',
        paneKey: 'pane-1'
      })
    )
  })

  it('schedules a complete alert with green accent and double-pulse vibration on done', async () => {
    await presentSocketNotificationFallback(
      alert({
        agentState: 'done',
        title: 'orca · main',
        body: 'Claude finished',
        paneKey: undefined,
        notificationId: 'agent:wt-1:tab-9%3Aleaf-1:12345'
      }),
      'host-1'
    )
    expect(mocks.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          title: '✅ orca · main',
          subtitle: 'Work Laptop · Task complete',
          color: '#10b981',
          vibrate: COMPLETE_VIBRATION_PATTERN,
          data: expect.objectContaining({
            paneKey: 'tab-9:leaf-1'
          })
        }),
        trigger: { channelId: 'orca-desktop-complete' }
      })
    )
    expect(getCurrentInAppNotificationBanner()?.paneKey).toBe('tab-9:leaf-1')
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

  it('suppresses both the OS notification and in-app capsule when viewing the target workspace', async () => {
    mocks.eligible.mockResolvedValue(false)
    await presentSocketNotificationFallback(alert({ agentState: 'waiting' }), 'host-1')
    expect(mocks.schedule).not.toHaveBeenCalled()
    expect(getCurrentInAppNotificationBanner()).toBeNull()
  })

  it('ignores notifications whose agentState is still working', async () => {
    await presentSocketNotificationFallback(alert({ agentState: 'working' }), 'host-1')
    expect(mocks.schedule).not.toHaveBeenCalled()
    expect(getCurrentInAppNotificationBanner()).toBeNull()
  })

  it('does not schedule or show in-app banner when eligibility flips the subscription to disposed', async () => {
    let disposed = false
    mocks.eligible.mockImplementation(async () => {
      disposed = true
      return true
    })
    await presentSocketNotificationFallback(alert(), 'host-1', () => disposed)
    expect(mocks.schedule).not.toHaveBeenCalled()
    expect(getCurrentInAppNotificationBanner()).toBeNull()
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
      trigger: { channelId: 'orca-desktop-complete' }
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
        title: '✅ Orca',
        subtitle: 'Work Laptop · Task complete',
        body: 'Test notification from Orca.',
        color: '#10b981',
        vibrate: COMPLETE_VIBRATION_PATTERN,
        priority: 'max',
        sound: soundValue
      },
      trigger
    })
    expect(getCurrentInAppNotificationBanner()?.title).toBe('Orca')
  })
})
