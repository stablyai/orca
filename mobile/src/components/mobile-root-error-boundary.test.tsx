import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dismissCrash: vi.fn().mockResolvedValue(undefined),
  getUndismissedCrash: vi.fn().mockResolvedValue(null),
  hideSplash: vi.fn().mockResolvedValue(undefined),
  preventAutoHide: vi.fn().mockResolvedValue(undefined),
  recordAppState: vi.fn().mockResolvedValue(undefined),
  recordRenderError: vi.fn().mockResolvedValue(undefined),
  recordRoute: vi.fn().mockResolvedValue(undefined),
  routerReplace: vi.fn(),
  routeShouldThrow: true,
  shareDiagnostics: vi.fn().mockResolvedValue(undefined),
  startSession: vi.fn().mockResolvedValue(null)
}))

vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: vi.fn() }) },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0 })
}))
vi.mock('lucide-react-native', () => ({
  AlertTriangle: 'AlertTriangle',
  House: 'House',
  RefreshCw: 'RefreshCw'
}))
vi.mock('expo-router', () => {
  function Stack(): null {
    if (mocks.routeShouldThrow) {
      throw new Error('route render exploded')
    }
    return null
  }
  Stack.Screen = 'StackScreen'
  return {
    Stack,
    useRouter: () => ({
      replace: mocks.routerReplace
    }),
    useSegments: () => ['h', '[hostId]', 'session', '[worktreeId]']
  }
})
vi.mock('expo-status-bar', () => ({ StatusBar: 'StatusBar' }))
vi.mock('expo-splash-screen', () => ({
  hideAsync: mocks.hideSplash,
  preventAutoHideAsync: mocks.preventAutoHide
}))
vi.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'default',
  addNotificationResponseReceivedListener: () => ({ remove: vi.fn() }),
  clearLastNotificationResponse: vi.fn(),
  getLastNotificationResponse: () => null,
  setNotificationHandler: vi.fn()
}))
vi.mock('expo-linking', () => ({
  addEventListener: () => ({ remove: vi.fn() }),
  getInitialURL: vi.fn().mockResolvedValue(null)
}))
vi.mock('./OrcaLogo', () => ({ OrcaLogo: 'OrcaLogo' }))
vi.mock('../transport/client-context', () => ({
  RpcClientProvider: ({ children }: { children: ReactNode }) => children
}))
vi.mock('../notifications/notification-routing', () => ({
  getNotificationNavigationTarget: vi.fn()
}))
vi.mock('../notifications/use-open-notification-route', () => ({
  useOpenNotificationRoute: () => vi.fn()
}))
vi.mock('../transport/host-store', () => ({ loadHostCatalog: vi.fn().mockResolvedValue([]) }))
vi.mock('../transport/pairing', () => ({ extractPairingCodeFromUrl: () => null }))
vi.mock('../transport/mobile-relay-pairing-recovery', () => ({
  recoverMobileRelayPairing: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('../diagnostics/mobile-crash-diagnostics', () => ({
  dismissPreviousMobileCrashSession: mocks.dismissCrash,
  getUndismissedPreviousMobileCrashSession: mocks.getUndismissedCrash,
  recordMobileAppState: mocks.recordAppState,
  recordMobileRenderError: mocks.recordRenderError,
  recordMobileRouteBreadcrumb: mocks.recordRoute,
  shareMobileCrashDiagnostics: mocks.shareDiagnostics,
  startMobileCrashSession: mocks.startSession
}))

import RootLayout from '../../app/_layout'
import { colors } from '../theme/mobile-theme'

describe('mobile root error boundary', () => {
  let renderer!: ReactTestRenderer

  beforeEach(() => {
    mocks.routeShouldThrow = true
    vi.clearAllMocks()
  })

  afterEach(() => {
    act(() => renderer.unmount())
    vi.restoreAllMocks()
  })

  it('contains a route render failure and shows recovery actions', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    act(() => {
      renderer = create(createElement(RootLayout))
    })

    const fallback = renderer.root.findByProps({ testID: 'mobile-root-error-boundary' })
    const buttons = fallback.findAllByType('Pressable')
    expect(buttons.map((button) => button.props.accessibilityLabel)).toEqual([
      'Retry',
      'Return home',
      'Report error'
    ])
    expect(console.error).toHaveBeenCalledWith(
      '[mobile-root-error-boundary] render crash contained by boundary',
      expect.any(Error),
      expect.objectContaining({ componentStack: expect.any(String) })
    )
    expect(mocks.recordRenderError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'route render exploded' }),
      expect.any(String)
    )
    expect(buttons[1]?.props.style).toEqual(
      expect.objectContaining({ backgroundColor: colors.bgRaised })
    )
    expect(buttons[1]?.findByType('House').props.color).toBe(colors.textPrimary)
    expect(buttons[2]?.findByType('AlertTriangle').props.color).toBe(colors.textPrimary)

    act(() => buttons[2]?.props.onPress())
    expect(mocks.shareDiagnostics).toHaveBeenCalledOnce()
  })

  it('retries by remounting the failed route', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    act(() => {
      renderer = create(createElement(RootLayout))
    })

    mocks.routeShouldThrow = false
    const retry = renderer.root.findByProps({ accessibilityLabel: 'Retry' })
    act(() => retry.props.onPress())

    expect(renderer.root.findAllByProps({ testID: 'mobile-root-error-boundary' })).toHaveLength(0)
  })

  it('records the route template after the navigator mounts', () => {
    mocks.routeShouldThrow = false
    act(() => {
      renderer = create(createElement(RootLayout))
    })

    expect(mocks.recordRoute).toHaveBeenCalledWith(['h', '[hostId]', 'session', '[worktreeId]'])
  })

  it('navigates home before remounting the failed route', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    act(() => {
      renderer = create(createElement(RootLayout))
    })

    mocks.routerReplace.mockImplementationOnce(() => {
      mocks.routeShouldThrow = false
    })
    const returnHome = renderer.root.findByProps({ accessibilityLabel: 'Return home' })
    act(() => returnHome.props.onPress())

    expect(mocks.routerReplace).toHaveBeenCalledWith('/')
    expect(renderer.root.findAllByProps({ testID: 'mobile-root-error-boundary' })).toHaveLength(0)
  })
})
