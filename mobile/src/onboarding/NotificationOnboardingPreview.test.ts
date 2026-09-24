import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotificationOnboardingPreview } from './NotificationOnboardingPreview'

const mocks = vi.hoisted(() => {
  const anim = () => ({ start: vi.fn(), stop: vi.fn() })
  return {
    reducedMotion: true,
    reducedMotionResult: null as Promise<boolean> | null,
    timing: vi.fn(anim),
    loop: vi.fn(anim)
  }
})

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
      isReduceMotionEnabled: vi.fn(
        () => mocks.reducedMotionResult ?? Promise.resolve(mocks.reducedMotion)
      )
    },
    Animated: {
      Value: AnimatedValue,
      View: ({ children, ...props }: { children?: unknown }) =>
        React.createElement('AnimatedView', props, children),
      delay: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
      loop: mocks.loop,
      parallel: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
      sequence: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
      timing: mocks.timing
    },
    Easing: { cubic: (t: number) => t, in: (e: unknown) => e, out: (e: unknown) => e },
    StyleSheet: { create: (styles: unknown) => styles },
    Text: 'Text',
    View: 'View'
  }
})

vi.mock('../components/OrcaLogo', () => ({ OrcaLogo: 'OrcaLogo' }))

describe('NotificationOnboardingPreview', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    mocks.reducedMotion = true
    mocks.reducedMotionResult = null
    mocks.timing.mockClear()
    mocks.loop.mockClear()
    vi.restoreAllMocks()
  })

  async function renderPreview(active = true) {
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] !== 'string' || !args[0].includes('react-test-renderer is deprecated')) {
        throw new Error(String(args[0]))
      }
    })
    await act(async () => {
      renderer = create(createElement(NotificationOnboardingPreview, { active }))
    })
    consoleError.mockRestore()
  }

  it('shows sample agent-done and needs-input banners as a decorative mock', async () => {
    await renderPreview()
    const preview = renderer!.root.findByProps({ testID: 'notification-onboarding-preview' })
    const copy = renderer!.root
      .findAllByType('Text')
      .map((node) => node.props.children)
      .flat()
      .join(' ')

    expect(preview.props.accessibilityElementsHidden).toBe(true)
    expect(preview.props.importantForAccessibility).toBe('no-hide-descendants')
    expect(copy).toContain('Codex finished')
    expect(copy).toContain('Claude needs input')
  })

  it('does not animate the banners when the page is off-screen', async () => {
    await renderPreview(false)
    expect(mocks.loop).not.toHaveBeenCalled()
  })

  it('loops the arriving banners while the page is active', async () => {
    mocks.reducedMotion = false
    await renderPreview(true)
    expect(mocks.loop).toHaveBeenCalledOnce()
    expect(mocks.loop.mock.results[0]?.value.start).toHaveBeenCalledOnce()
  })

  it('does not start the loop until reduced-motion is known', async () => {
    let resolvePreference: (enabled: boolean) => void = () => {}
    mocks.reducedMotionResult = new Promise((resolve) => {
      resolvePreference = resolve
    })

    await renderPreview(true)
    expect(mocks.loop).not.toHaveBeenCalled()

    await act(async () => {
      resolvePreference(false)
    })
    expect(mocks.loop).toHaveBeenCalledOnce()
  })
})
