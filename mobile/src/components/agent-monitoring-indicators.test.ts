import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSpinner } from './AgentSpinner'
import { AgentStateDot } from './AgentStateDot'

const DESKTOP_WORKING_COLOR = '#eab308'

type MonitoringTestRenderer = {
  readonly root: {
    findByType(type: string): { props: Record<string, unknown> }
  }
  unmount(): void
}

const { animationLoop, animationTiming, setValue } = vi.hoisted(() => ({
  animationLoop: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  animationTiming: vi.fn(() => ({})),
  setValue: vi.fn()
}))

vi.mock('lucide-react-native', () => ({ Radio: 'Radio' }))
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
  StyleSheet: { create: <T>(styles: T) => styles },
  View: 'View'
}))

describe('mobile monitoring indicators', () => {
  let renderer: MonitoringTestRenderer | null = null

  beforeEach(() => {
    animationLoop.mockClear()
    animationTiming.mockClear()
    setValue.mockClear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('renders a static Radio for a monitoring agent', async () => {
    await act(async () => {
      renderer = create(createElement(AgentStateDot, { state: 'monitoring' }))
    })

    expect(renderer?.root.findByType('Radio').props).toMatchObject({
      color: DESKTOP_WORKING_COLOR,
      size: 10
    })
    expect(animationTiming).not.toHaveBeenCalled()
    expect(animationLoop).not.toHaveBeenCalled()
  })

  it('renders a static Radio for an all-monitoring workspace', async () => {
    await act(async () => {
      renderer = create(
        createElement(AgentSpinner, { status: 'working', workingMode: 'monitoring' })
      )
    })

    expect(renderer?.root.findByType('Radio').props).toMatchObject({
      color: DESKTOP_WORKING_COLOR,
      size: 12
    })
    expect(animationTiming).not.toHaveBeenCalled()
    expect(animationLoop).not.toHaveBeenCalled()
  })

  it('keeps the spinner fallback when workingMode is absent', async () => {
    await act(async () => {
      renderer = create(createElement(AgentSpinner, { status: 'working' }))
    })

    expect(animationTiming).toHaveBeenCalledOnce()
    expect(animationLoop).toHaveBeenCalledOnce()
  })
})
