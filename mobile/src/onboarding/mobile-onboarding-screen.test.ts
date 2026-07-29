import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MobileOnboardingScreen from '../../app/mobile-onboarding'

const mocks = vi.hoisted(() => ({
  params: { hostId: 'paired-host', steps: 'session-view,notifications' },
  replace: vi.fn(),
  reducedMotionEnabled: false,
  animatedTiming: vi.fn(),
  ensureNotificationPermissions: vi.fn(),
  saveDefaultSessionView: vi.fn(),
  savePushNotificationsEnabled: vi.fn()
}))

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    isReduceMotionEnabled: vi.fn(() => Promise.resolve(mocks.reducedMotionEnabled))
  },
  Animated: {
    Value: class {},
    View: 'AnimatedView',
    multiply: vi.fn(() => 0),
    timing: mocks.animatedTiming
  },
  BackHandler: {
    addEventListener: vi.fn(() => ({ remove: vi.fn() }))
  },
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View',
  useWindowDimensions: () => ({ width: 390, height: 844 })
}))

vi.mock('expo-router', () => ({
  useFocusEffect: vi.fn(),
  useLocalSearchParams: () => mocks.params,
  useRouter: () => ({ replace: mocks.replace })
}))

vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('../components/OrcaLogo', () => ({ OrcaLogo: 'OrcaLogo' }))
vi.mock('./MobileOnboardingPage', () => ({ MobileOnboardingPage: 'MobileOnboardingPage' }))
vi.mock('../notifications/mobile-notifications', () => ({
  ensureNotificationPermissions: mocks.ensureNotificationPermissions
}))
vi.mock('../storage/session-view-preferences', () => ({
  saveDefaultSessionView: mocks.saveDefaultSessionView
}))
vi.mock('../storage/preferences', () => ({
  savePushNotificationsEnabled: mocks.savePushNotificationsEnabled
}))

describe('MobileOnboardingScreen', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    mocks.params = { hostId: 'paired-host', steps: 'session-view,notifications' }
    mocks.replace.mockReset()
    mocks.reducedMotionEnabled = false
    mocks.animatedTiming.mockReset().mockReturnValue({
      start: (callback: (result: { finished: boolean }) => void) => callback({ finished: true })
    })
    mocks.ensureNotificationPermissions.mockReset().mockResolvedValue(true)
    mocks.saveDefaultSessionView.mockReset().mockResolvedValue(undefined)
    mocks.savePushNotificationsEnabled.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  async function renderScreen() {
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] !== 'string' || !args[0].includes('react-test-renderer is deprecated')) {
        throw new Error(String(args[0]))
      }
    })
    await act(async () => {
      renderer = create(createElement(MobileOnboardingScreen))
    })
    consoleError.mockRestore()
  }

  function pages() {
    return renderer!.root.findAllByType('MobileOnboardingPage')
  }

  it('advances from session view to notifications before opening the paired host', async () => {
    await renderScreen()
    expect(pages().map((page) => page.props.active)).toEqual([true, false])

    await act(async () => pages()[0].props.onSessionChoice('chat'))
    expect(mocks.saveDefaultSessionView).toHaveBeenCalledWith('chat')
    expect(pages().map((page) => page.props.active)).toEqual([false, true])
    expect(mocks.replace).not.toHaveBeenCalled()

    await act(async () => pages()[1].props.onNotificationChoice('skip'))
    expect(mocks.ensureNotificationPermissions).not.toHaveBeenCalled()
    expect(mocks.savePushNotificationsEnabled).toHaveBeenCalledWith(false)
    expect(mocks.replace).toHaveBeenCalledWith('/h/paired-host')
  })

  it('finishes immediately when the plan contains only one outstanding step', async () => {
    mocks.params = { hostId: 'paired-host', steps: 'session-view' }
    await renderScreen()

    await act(async () => pages()[0].props.onSessionChoice('terminal'))
    expect(mocks.replace).toHaveBeenCalledWith('/h/paired-host')
  })

  it('keeps the current step retryable when persistence fails', async () => {
    mocks.params = { hostId: 'paired-host', steps: 'session-view' }
    mocks.saveDefaultSessionView
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValueOnce(undefined)
    await renderScreen()

    await act(async () => pages()[0].props.onSessionChoice('chat'))
    expect(pages()[0].props.error).toBe('Your choice could not be saved. Try again.')

    await act(async () => pages()[0].props.onSessionChoice('chat'))
    expect(mocks.saveDefaultSessionView).toHaveBeenCalledTimes(2)
    expect(mocks.replace).toHaveBeenCalledWith('/h/paired-host')
  })

  it('resets carousel state when the route supplies a new onboarding plan', async () => {
    await renderScreen()
    await act(async () => pages()[0].props.onSessionChoice('chat'))
    expect(pages().map((page) => page.props.active)).toEqual([false, true])

    mocks.params = { hostId: 'paired-host', steps: 'notifications' }
    await act(async () => renderer!.update(createElement(MobileOnboardingScreen)))

    expect(pages()).toHaveLength(1)
    expect(pages()[0].props).toMatchObject({ step: 'notifications', active: true })
  })

  it('skips the slide animation when the device requests reduced motion', async () => {
    mocks.reducedMotionEnabled = true
    await renderScreen()

    await act(async () => pages()[0].props.onSessionChoice('chat'))

    expect(mocks.animatedTiming).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ duration: 0, useNativeDriver: true })
    )
  })

  it('keeps the next decision available if the cosmetic transition is interrupted', async () => {
    mocks.animatedTiming.mockReturnValue({
      start: (callback: (result: { finished: boolean }) => void) => callback({ finished: false })
    })
    await renderScreen()

    await act(async () => pages()[0].props.onSessionChoice('chat'))

    expect(pages()[1].props).toMatchObject({ active: true, busyChoice: null })
  })
})
