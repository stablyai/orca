import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileAgentWorkingIndicator } from './MobileAgentWorkingIndicator'

const mocks = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }))

vi.mock('react-native', () => {
  const animation = { start: mocks.start, stop: mocks.stop }
  return {
    Animated: {
      Value: class {},
      View: 'AnimatedView',
      delay: vi.fn(() => animation),
      loop: vi.fn(() => animation),
      sequence: vi.fn(() => animation),
      timing: vi.fn(() => animation)
    },
    StyleSheet: { create: (styles: unknown) => styles },
    Text: 'Text',
    View: 'View'
  }
})

function suppressRendererWarning(): () => void {
  const original = console.error
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
      return
    }
    original(...args)
  })
  return () => spy.mockRestore()
}

describe('MobileAgentWorkingIndicator', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    mocks.start.mockClear()
    mocks.stop.mockClear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function render(stale?: boolean): Promise<void> {
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(createElement(MobileAgentWorkingIndicator, { stale }))
      })
    } finally {
      restore()
    }
  }

  function label(): string {
    return renderer!.root
      .findAll((node) => node.type === 'Text')
      .map((node) => node.props.children)
      .join('')
  }

  function dots(): number {
    return renderer!.root.findAll((node) => node.type === 'AnimatedView').length
  }

  function liveRegion(): unknown {
    return renderer!.root.find((node) => node.type === 'View').props.accessibilityLiveRegion
  }

  it('animates a live working row', async () => {
    await render(false)

    expect(label()).toBe('Agent is working')
    expect(dots()).toBe(3)
    expect(mocks.start).toHaveBeenCalledTimes(3)
    // Android needs the live-region mode before the content changes.
    expect(liveRegion()).toBe('polite')
  })

  it('mutes the row and stops the animation while the status is stale', async () => {
    await render(true)

    expect(label()).toBe('Agent status stale')
    // Dots must not imply live activity after a disconnect.
    expect(dots()).toBe(0)
    expect(mocks.start).not.toHaveBeenCalled()
    expect(liveRegion()).toBe('polite')
  })

  it('stops the running animation when a live row goes stale', async () => {
    await render(false)
    mocks.start.mockClear()

    await act(async () => {
      renderer!.update(createElement(MobileAgentWorkingIndicator, { stale: true }))
    })

    expect(mocks.stop).toHaveBeenCalledTimes(3)
    expect(mocks.start).not.toHaveBeenCalled()
    expect(label()).toBe('Agent status stale')
  })

  it('resumes the animation when the transport recovers', async () => {
    await render(true)

    await act(async () => {
      renderer!.update(createElement(MobileAgentWorkingIndicator, { stale: false }))
    })

    expect(mocks.start).toHaveBeenCalledTimes(3)
    expect(label()).toBe('Agent is working')
    expect(dots()).toBe(3)
  })
})
