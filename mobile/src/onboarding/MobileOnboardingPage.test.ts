import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileOnboardingPage } from './MobileOnboardingPage'

vi.mock('react-native', async () => {
  const React = await import('react')
  class AnimatedValue {
    interpolate() {
      return 0
    }
    setValue() {}
  }
  return {
    AccessibilityInfo: {
      addEventListener: vi.fn(() => ({ remove: vi.fn() })),
      isReduceMotionEnabled: vi.fn(() => Promise.resolve(true))
    },
    ActivityIndicator: 'ActivityIndicator',
    Animated: {
      Value: AnimatedValue,
      View: 'AnimatedView',
      delay: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
      loop: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
      parallel: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
      sequence: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
      timing: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() }))
    },
    Easing: { cubic: (t: number) => t, in: (e: unknown) => e, out: (e: unknown) => e },
    Image: 'Image',
    Pressable: 'Pressable',
    ScrollView: ({ children, ...props }: { children?: unknown }) =>
      React.createElement('ScrollView', props, children),
    StyleSheet: { create: (styles: unknown) => styles },
    Text: 'Text',
    View: 'View'
  }
})

vi.mock('lucide-react-native', () => ({
  MessageSquare: 'MessageSquare'
}))

vi.mock('../components/OrcaLogo', () => ({ OrcaLogo: 'OrcaLogo' }))

describe('MobileOnboardingPage', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  async function renderPage(
    step: 'session-view' | 'notifications',
    options: { active?: boolean; busyChoice?: 'chat' | 'enable' | null } = {}
  ) {
    const onSessionChoice = vi.fn()
    const onNotificationChoice = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] !== 'string' || !args[0].includes('react-test-renderer is deprecated')) {
        throw new Error(String(args[0]))
      }
    })
    await act(async () => {
      renderer = create(
        createElement(MobileOnboardingPage, {
          step,
          width: 390,
          active: options.active ?? true,
          busyChoice: options.busyChoice ?? null,
          error: null,
          onSessionChoice,
          onNotificationChoice
        })
      )
    })
    consoleError.mockRestore()
    return { onSessionChoice, onNotificationChoice }
  }

  function button(label: string) {
    return renderer!.root.find(
      (node) => node.type === 'Pressable' && node.props.accessibilityLabel === label
    )
  }

  function collectText(): string {
    return renderer!.root
      .findAllByType('Text')
      .map((node) => node.props.children)
      .flat()
      .join(' ')
  }

  it('renders the session choices and sends exactly one selected view', async () => {
    const callbacks = await renderPage('session-view')

    act(() => button('Open sessions in Chat UI').props.onPress())
    expect(callbacks.onSessionChoice).toHaveBeenCalledWith('chat')
    expect(callbacks.onNotificationChoice).not.toHaveBeenCalled()
  })

  it('renders the notification choices and sends the selected option', async () => {
    const callbacks = await renderPage('notifications')
    act(() => button('Skip notifications for now').props.onPress())

    expect(callbacks.onNotificationChoice).toHaveBeenCalledWith('skip')
    expect(callbacks.onSessionChoice).not.toHaveBeenCalled()
  })

  it('explains that alerts cover finished work and waiting agents, even if the app is closed', async () => {
    await renderPage('notifications')
    const copy = collectText()

    expect(copy).toContain('Don’t miss when an agent needs you')
    expect(copy).toContain('finishes or is waiting')
    expect(copy).toContain('using the app')
    expect(copy).toContain('Enable notifications')
    expect(copy).toContain('Codex finished')
    expect(copy).toContain('Claude needs input')
    expect(renderer!.root.findByProps({ testID: 'notification-onboarding-preview' })).toBeTruthy()
  })

  it('disables both notification choices while permission is pending', async () => {
    await renderPage('notifications', { busyChoice: 'enable' })
    const enable = button('Enable agent notifications')
    const secondary = button('Skip notifications for now')

    expect(enable.props.disabled).toBe(true)
    expect(secondary.props.disabled).toBe(true)
  })

  it('hides an off-screen page from assistive technology', async () => {
    await renderPage('notifications', { active: false })
    const scrollView = renderer!.root.findByType('ScrollView')

    expect(scrollView.props.accessibilityElementsHidden).toBe(true)
    expect(scrollView.props.importantForAccessibility).toBe('no-hide-descendants')
  })
})
