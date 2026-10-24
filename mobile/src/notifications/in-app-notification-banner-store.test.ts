import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dismissInAppNotificationBanner,
  dismissInAppNotificationBannerById,
  getCurrentInAppNotificationBanner,
  publishInAppNotificationBanner,
  resetInAppNotificationBannerForTests,
  subscribeInAppNotificationBanner
} from './in-app-notification-banner-store'

beforeEach(() => {
  resetInAppNotificationBannerForTests()
})

describe('in-app-notification-banner-store', () => {
  it('publishes and dismisses the active banner', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeInAppNotificationBanner(listener)

    publishInAppNotificationBanner({
      id: 'banner-1',
      tone: 'urgent',
      hostId: 'host-1',
      hostName: 'Work Laptop',
      title: 'orca · main',
      body: 'Claude is waiting for input',
      notificationId: 'agent:wt-1:pane-1:1',
      createdAt: 100
    })

    expect(getCurrentInAppNotificationBanner()?.id).toBe('banner-1')
    expect(listener).toHaveBeenCalledTimes(1)

    dismissInAppNotificationBanner('other-banner')
    expect(getCurrentInAppNotificationBanner()?.id).toBe('banner-1')

    dismissInAppNotificationBanner('banner-1')
    expect(getCurrentInAppNotificationBanner()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('dismisses by notificationId and hostId', () => {
    publishInAppNotificationBanner({
      id: 'banner-2',
      tone: 'complete',
      hostId: 'host-1',
      hostName: 'Work Laptop',
      title: 'orca · main',
      body: 'Task complete',
      notificationId: 'agent:wt-1:pane-1:2',
      createdAt: 200
    })

    dismissInAppNotificationBannerById('agent:wt-1:pane-1:2', 'host-2')
    expect(getCurrentInAppNotificationBanner()?.id).toBe('banner-2')

    dismissInAppNotificationBannerById('agent:wt-1:pane-1:2', 'host-1')
    expect(getCurrentInAppNotificationBanner()).toBeNull()
  })
})
