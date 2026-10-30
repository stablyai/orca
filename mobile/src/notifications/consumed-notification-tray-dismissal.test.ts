import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Notifications from 'expo-notifications'
import {
  dismissConsumedTrayNotifications,
  dismissSupersededPaneTrayNotifications,
  isNotificationTargetConsumed,
  markNotificationTargetConsumed,
  resetConsumedNotificationsForTests
} from './consumed-notification-tray-dismissal'

vi.mock('expo-notifications', () => ({
  getPresentedNotificationsAsync: vi.fn(),
  dismissNotificationAsync: vi.fn()
}))

function presented(identifier: string, data: unknown): unknown {
  return { request: { identifier, content: { data } } }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetConsumedNotificationsForTests()
  vi.mocked(Notifications.dismissNotificationAsync).mockResolvedValue(undefined)
  vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([])
})

describe('consumed-notification-tray-dismissal', () => {
  it('marks consumed identifiers and sweeps both direct identifier and matching pane notifications from the OS tray', async () => {
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      presented('fp-1:agent:wt-1:pane-1:100', {
        hostId: 'host-1',
        hostFingerprint: 'fp-1',
        notificationId: 'agent:wt-1:pane-1:100',
        worktreeId: 'wt-1',
        paneKey: 'pane-1'
      }),
      presented('fp-1:agent:wt-1:pane-1:200', {
        hostId: 'host-1',
        hostFingerprint: 'fp-1',
        notificationId: 'agent:wt-1:pane-1:200',
        worktreeId: 'wt-1',
        paneKey: 'pane-1'
      }),
      presented('fp-1:agent:wt-1:pane-2:300', {
        hostId: 'host-1',
        hostFingerprint: 'fp-1',
        notificationId: 'agent:wt-1:pane-2:300',
        worktreeId: 'wt-1',
        paneKey: 'pane-2'
      })
    ] as never)

    await dismissConsumedTrayNotifications({
      id: 'fp-1:agent:wt-1:pane-1:200',
      osNotificationIdentifier: 'fp-1:agent:wt-1:pane-1:200',
      notificationId: 'agent:wt-1:pane-1:200',
      hostId: 'host-1',
      worktreeId: 'wt-1',
      paneKey: 'pane-1'
    })

    expect(
      isNotificationTargetConsumed({
        osNotificationIdentifier: 'fp-1:agent:wt-1:pane-1:200',
        notificationId: 'agent:wt-1:pane-1:200'
      })
    ).toBe(true)

    const dismissedIds = new Set(
      vi.mocked(Notifications.dismissNotificationAsync).mock.calls.map(([id]) => id)
    )
    expect(dismissedIds.has('fp-1:agent:wt-1:pane-1:100')).toBe(true)
    expect(dismissedIds.has('fp-1:agent:wt-1:pane-1:200')).toBe(true)
    expect(dismissedIds.has('fp-1:agent:wt-1:pane-2:300')).toBe(false)
  })

  it('dismisses superseded older notifications for the same pane while keeping the newly scheduled identifier', async () => {
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      presented('fp-1:agent:wt-1:pane-1:100', {
        hostId: 'host-1',
        hostFingerprint: 'fp-1',
        notificationId: 'agent:wt-1:pane-1:100',
        worktreeId: 'wt-1',
        paneKey: 'pane-1'
      }),
      presented('fp-1:agent:wt-1:pane-1:200', {
        hostId: 'host-1',
        hostFingerprint: 'fp-1',
        notificationId: 'agent:wt-1:pane-1:200',
        worktreeId: 'wt-1',
        paneKey: 'pane-1'
      })
    ] as never)

    await dismissSupersededPaneTrayNotifications(
      {
        hostId: 'host-1',
        hostFingerprint: 'fp-1',
        worktreeId: 'wt-1',
        paneKey: 'pane-1'
      },
      'fp-1:agent:wt-1:pane-1:200'
    )

    expect(vi.mocked(Notifications.dismissNotificationAsync).mock.calls.map(([id]) => id)).toEqual([
      'fp-1:agent:wt-1:pane-1:100'
    ])
  })

  it('tracks consumed targets by notificationId even before osNotificationIdentifier is known', () => {
    markNotificationTargetConsumed({ notificationId: 'agent:wt-1:pane-1:999' })
    expect(isNotificationTargetConsumed({ notificationId: 'agent:wt-1:pane-1:999' })).toBe(true)
    expect(isNotificationTargetConsumed({ notificationId: 'agent:wt-1:pane-1:888' })).toBe(false)
  })
})
