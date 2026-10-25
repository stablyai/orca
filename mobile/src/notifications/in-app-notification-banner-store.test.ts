import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InAppNotificationBanner } from './InAppNotificationBanner'
import {
  dismissInAppNotificationBanner,
  dismissInAppNotificationBannerById,
  getCurrentInAppNotificationBanner,
  publishInAppNotificationBanner,
  resetInAppNotificationBannerForTests,
  subscribeInAppNotificationBanner
} from './in-app-notification-banner-store'

const bannerMocks = vi.hoisted(() => ({
  pathname: '/',
  params: {} as { hostId?: string; worktreeId?: string },
  replace: vi.fn(),
  openNotificationRoute: vi.fn(),
  dismissConsumed: vi.fn(async () => {})
}))

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (value: unknown) => value }
}))
vi.mock('expo-router', () => ({
  usePathname: () => bannerMocks.pathname,
  useGlobalSearchParams: () => bannerMocks.params,
  useRouter: () => ({ replace: bannerMocks.replace })
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('./use-open-notification-route', () => ({
  useOpenNotificationRoute: () => bannerMocks.openNotificationRoute
}))
vi.mock('./consumed-notification-tray-dismissal', () => ({
  dismissConsumedTrayNotifications: bannerMocks.dismissConsumed
}))

beforeEach(() => {
  vi.clearAllMocks()
  bannerMocks.pathname = '/'
  bannerMocks.params = {}
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

  it('does not let a stale fenced dismissal clear a newer banner', () => {
    publishInAppNotificationBanner({
      id: 'banner-3',
      tone: 'urgent',
      hostId: 'host-1',
      hostName: 'Work Laptop',
      title: 'orca · main',
      body: 'Needs input',
      notificationId: 'agent:wt-1:pane-1:3',
      notificationEpoch: 'epoch-1',
      notificationSeq: 5,
      createdAt: 300
    })

    dismissInAppNotificationBannerById('agent:wt-1:pane-1:3', 'host-1', {
      notificationEpoch: 'epoch-1',
      notificationSeq: 4
    })
    expect(getCurrentInAppNotificationBanner()?.id).toBe('banner-3')

    dismissInAppNotificationBannerById('agent:wt-1:pane-1:3', 'host-1', {
      notificationEpoch: 'other-epoch',
      notificationSeq: 9
    })
    expect(getCurrentInAppNotificationBanner()?.id).toBe('banner-3')

    dismissInAppNotificationBannerById('agent:wt-1:pane-1:3', 'host-1')
    expect(getCurrentInAppNotificationBanner()?.id).toBe('banner-3')

    dismissInAppNotificationBannerById('agent:wt-1:pane-1:3', 'host-1', {
      notificationEpoch: 'epoch-1',
      notificationSeq: 5
    })
    expect(getCurrentInAppNotificationBanner()).toBeNull()
  })

  it('renders sibling Pressables, sets live-region accessibility props, restarts timer on createdAt change, and navigates host-only banners', async () => {
    vi.useFakeTimers()
    let renderer!: ReturnType<typeof create>
    try {
      await act(async () => {
        publishInAppNotificationBanner({
          id: 'banner-host-only',
          tone: 'urgent',
          hostId: 'host-1',
          hostName: 'Work Laptop',
          title: 'Needs input',
          body: 'Check host',
          createdAt: 1000
        })
        renderer = create(createElement(InAppNotificationBanner))
      })

      const rootView = renderer.root.findByType('View')
      expect(rootView.props.accessibilityRole).toBe('alert')
      expect(rootView.props.accessibilityLiveRegion).toBe('assertive')

      const pressables = renderer.root.findAllByType('Pressable')
      expect(pressables).toHaveLength(2)
      expect(pressables[0].findAllByType('Pressable')).toHaveLength(1)
      const urgentTextValues = pressables[0]
        .findAllByType('Text')
        .map((node) => node.props.children)
      expect(urgentTextValues).toEqual(['⚡', 'Needs input', 'Check host'])
      expect(urgentTextValues).not.toContain('Jump →')

      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000)
        publishInAppNotificationBanner({
          id: 'banner-host-only',
          tone: 'complete',
          hostId: 'host-1',
          hostName: 'Work Laptop',
          title: 'orca / main - Claude finished',
          prompt: 'Fix the notification capsule layout',
          body: 'Updated the banner to show prompt and output.',
          createdAt: 2000
        })
      })

      expect(renderer.root.findByType('View').props.accessibilityRole).toBeUndefined()
      expect(renderer.root.findByType('View').props.accessibilityLiveRegion).toBe('polite')
      const completeTextNodes = renderer.root
        .findAllByType('Pressable')[0]
        .findAllByType('Text')
      expect(completeTextNodes.map((node) => node.props.children)).toEqual([
        '✅',
        'orca / main - Claude finished',
        'Fix the notification capsule layout',
        'Updated the banner to show prompt and output.'
      ])
      expect(completeTextNodes[1].props.numberOfLines).toBe(1)
      expect(completeTextNodes[2].props.numberOfLines).toBe(1)
      expect(completeTextNodes[3].props.numberOfLines).toBe(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000)
      })
      expect(getCurrentInAppNotificationBanner()?.id).toBe('banner-host-only')

      await act(async () => {
        renderer.root.findAllByType('Pressable')[0].props.onPress()
      })
      expect(bannerMocks.openNotificationRoute).toHaveBeenCalledWith({
        hostId: 'host-1',
        sessionTarget: null
      })
      expect(getCurrentInAppNotificationBanner()).toBeNull()
    } finally {
      await act(async () => renderer?.unmount())
      vi.useRealTimers()
    }
  })
})
