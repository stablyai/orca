import { createElement, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSpinner } from './AgentSpinner'
import { AgentStateDot } from './AgentStateDot'
import { colors } from '../theme/mobile-theme'
import { findAllByHostType, findByHostType } from '../test-support/react-test-renderer-host-nodes'

const DESKTOP_WORKING_COLOR = '#eab308'

async function mount(element: ReactElement): Promise<ReactTestRenderer> {
  const mounted: { renderer?: ReactTestRenderer } = {}
  await act(async () => {
    mounted.renderer = create(element)
  })
  if (!mounted.renderer) {
    throw new Error('indicator did not mount')
  }
  return mounted.renderer
}

const { animationLoop, animationTiming, setValue } = vi.hoisted(() => ({
  animationLoop: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  animationTiming: vi.fn(() => ({})),
  setValue: vi.fn()
}))

vi.mock('lucide-react-native', () => ({ Activity: 'Activity' }))
vi.mock('react-native', () => ({
  Animated: {
    Value: function Value() {
      return { interpolate: vi.fn(() => 'rotation'), setValue }
    },
    View: 'AnimatedView',
    loop: animationLoop,
    timing: animationTiming
  },
  Easing: { linear: 'linear' },
  Platform: { OS: 'ios' },
  StyleSheet: { create: <T>(styles: T) => styles },
  View: 'View'
}))

describe('mobile monitoring indicators', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    animationLoop.mockClear()
    animationTiming.mockClear()
    setValue.mockClear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('renders a static Activity heartbeat for a monitoring agent', async () => {
    renderer = await mount(createElement(AgentStateDot, { state: 'monitoring' }))

    expect(findByHostType(renderer.root, 'Activity').props).toMatchObject({
      color: DESKTOP_WORKING_COLOR,
      size: 10
    })
    expect(animationTiming).not.toHaveBeenCalled()
    expect(animationLoop).not.toHaveBeenCalled()
  })

  it('renders a static Activity heartbeat for an all-monitoring workspace', async () => {
    renderer = await mount(
      createElement(AgentSpinner, { status: 'working', workingMode: 'monitoring' })
    )

    expect(findByHostType(renderer.root, 'Activity').props).toMatchObject({
      color: DESKTOP_WORKING_COLOR,
      size: 12
    })
    expect(animationTiming).not.toHaveBeenCalled()
    expect(animationLoop).not.toHaveBeenCalled()
  })

  it('keeps the spinner fallback when workingMode is absent', async () => {
    renderer = await mount(createElement(AgentSpinner, { status: 'working' }))

    expect(animationTiming).toHaveBeenCalledOnce()
    expect(animationLoop).toHaveBeenCalledOnce()
  })

  it('keeps both native working rings off the interaction queue', async () => {
    renderer = await mount(
      createElement('View', null, [
        createElement(AgentSpinner, { key: 'spinner', status: 'working' }),
        createElement(AgentStateDot, { key: 'dot', state: 'working' })
      ])
    )

    expect(animationTiming).toHaveBeenCalledTimes(2)
    for (const call of animationTiming.mock.calls) {
      expect(call).toEqual([
        expect.anything(),
        expect.objectContaining({ useNativeDriver: true, isInteraction: false })
      ])
    }
  })

  it.each([
    // A user's Stop is not news: muted, never the fault red a failure draws.
    ['interrupted', colors.textMuted],
    ['failed', '#ef4444']
  ] as const)('draws %s with its own dot colour', async (state, color) => {
    renderer = await mount(createElement(AgentStateDot, { state }))

    const dot = findAllByHostType(renderer.root, 'View').find((view) =>
      Array.isArray(view.props.style)
    )
    expect(dot?.props.style).toContainEqual({ backgroundColor: color })
  })
})
