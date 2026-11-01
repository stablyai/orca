import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'

const startup = vi.hoisted(() => ({
  fail: true,
  replace: vi.fn(),
  openNotification: vi.fn(),
  readLink: vi.fn(async () => 'orca://pair?code=cold-code'),
  readNotification: vi.fn(() => ({
    actionIdentifier: 'default',
    notification: {
      request: { identifier: 'cold-tap', content: { data: { hostId: 'desktop' } }, trigger: null }
    }
  }))
}))
const router = { replace: startup.replace }
vi.mock('expo-router', () => ({
  Stack: Object.assign(
    () => {
      if (startup.fail) {
        throw new Error('first native render failed')
      }
      return null
    },
    { Screen: () => null }
  ),
  useRouter: () => router,
  useSegments: () => ['about'],
  useGlobalSearchParams: () => ({}),
  usePathname: () => '/about'
}))
vi.mock('react-native', () => ({
  Text: 'Text',
  View: 'View',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles }
}))
vi.mock('expo-linking', () => ({
  getInitialURL: startup.readLink,
  addEventListener: () => ({ remove: () => {} })
}))
vi.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'default',
  getLastNotificationResponse: startup.readNotification,
  clearLastNotificationResponse: () => {},
  setNotificationHandler: () => {},
  addNotificationResponseReceivedListener: () => ({ remove: () => {} })
}))
vi.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: async () => {},
  hideAsync: async () => {}
}))
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} }
}))
vi.mock('../notifications/android-foreground-push', () => ({
  startAndroidForegroundPushPresentation: () => () => {}
}))
vi.mock('../notifications/push-background-dismissal', () => ({
  registerPushDismissalTask: async () => {}
}))
vi.mock('../notifications/notification-viewing-policy', () => ({
  setNotificationViewingWorkspace: () => {}
}))
vi.mock('../notifications/use-open-notification-route', () => ({
  useOpenNotificationRoute: () => startup.openNotification
}))
vi.mock('../notifications/push-receive', () => ({
  foregroundNotificationBehavior: async () => ({}),
  isRemotePushTrigger: () => false,
  pushNotificationRouteData: (data: unknown) => data
}))
vi.mock('../notifications/push-registration', () => ({ startPushTokenSync: () => () => {} }))
vi.mock('../notifications/desktop-notification-channel', () => ({
  ensureDesktopNotificationChannel: async () => {}
}))
vi.mock('../transport/host-store', () => ({ loadHostCatalog: async () => [{ id: 'desktop' }] }))
vi.mock('../transport/mobile-relay-pairing-recovery', () => ({
  recoverMobileRelayPairing: async () => {}
}))
vi.mock('../transport/client-context', () => ({
  RpcClientProvider: ({ children }: { children: ReactNode }) => children
}))
vi.mock('../components/OrcaLogo', () => ({ OrcaLogo: () => null }))
vi.mock('../layout/side-safe-area', () => ({
  SideSafeArea: ({ children }: { children: ReactNode }) => children
}))
vi.mock('../layout/side-rail', () => ({
  SideRailProvider: ({ children }: { children: ReactNode }) => children
}))
vi.mock('../theme/mobile-appearance', () => ({ startMobileAppearance: async () => {} }))
vi.mock('../i18n/use-follow-device-ui-locale', () => ({ useFollowDeviceUiLocale: () => {} }))
vi.mock('../i18n/ui-language-preference', () => ({ startMobileUiLanguage: async () => {} }))
vi.mock('../app-update/app-update-runtime', () => ({ appUpdateChecker: { start: () => () => {} } }))

import RootLayout, { ErrorBoundary } from '../../app/_layout'

it('recovery Home discards unread cold links and notification taps after a first-render failure', async () => {
  await expect(
    act(async () => {
      create(createElement(RootLayout))
    })
  ).rejects.toThrow('first native render failed')
  expect(startup.readLink).not.toHaveBeenCalled()
  expect(startup.readNotification).not.toHaveBeenCalled()

  const mounted: { fallback?: ReactTestRenderer; recovered?: ReactTestRenderer } = {}
  await act(async () => {
    mounted.fallback = create(
      createElement(ErrorBoundary, {
        error: new Error('first native render failed'),
        retry: async () => {}
      })
    )
  })
  const fallback = mounted.fallback
  if (!fallback) {
    throw new Error('native recovery fallback did not mount')
  }
  const home = findAllByHostType(fallback.root, 'Pressable').find((button) =>
    findAllByHostType(button, 'Text').some((label) => label.props.children === 'Home')
  )
  expect(home).toBeDefined()
  await act(async () => home?.props.onPress())
  expect(startup.replace).toHaveBeenCalledExactlyOnceWith('/')
  await act(async () => fallback.unmount())

  startup.fail = false
  await act(async () => {
    mounted.recovered = create(createElement(RootLayout))
  })
  const recovered = mounted.recovered
  if (!recovered) {
    throw new Error('native root did not mount after recovery')
  }
  expect(startup.openNotification).not.toHaveBeenCalled()
  expect(startup.readNotification).not.toHaveBeenCalled()
  expect(startup.readLink).not.toHaveBeenCalled()
  expect(startup.replace).toHaveBeenCalledTimes(1)
  await act(async () => recovered.unmount())
})
