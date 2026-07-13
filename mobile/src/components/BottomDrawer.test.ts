import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const animation = vi.hoisted(() => ({
  timingCallbacks: [] as Array<((finished: boolean) => void) | undefined>
}))

vi.mock('react-native', () => ({
  BackHandler: { addEventListener: () => ({ remove: vi.fn() }) },
  Keyboard: { addListener: () => ({ remove: vi.fn() }), dismiss: vi.fn() },
  Modal: 'Modal',
  Platform: {
    OS: 'ios',
    select: (options: { ios?: unknown; default?: unknown }) => options.ios ?? options.default
  },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: {
    absoluteFill: {},
    absoluteFillObject: {},
    create: (styles: unknown) => styles
  },
  View: 'View',
  useWindowDimensions: () => ({ height: 800, width: 400 })
}))

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 })
}))

function chainableGesture() {
  const gesture: Record<string, (...args: unknown[]) => unknown> = {}
  for (const method of [
    'activeOffsetY',
    'onBegin',
    'onEnd',
    'onUpdate',
    'simultaneousWithExternalGesture'
  ]) {
    gesture[method] = () => gesture
  }
  return gesture
}

vi.mock('react-native-gesture-handler', () => ({
  Gesture: { Native: chainableGesture, Pan: chainableGesture },
  GestureDetector: 'GestureDetector',
  GestureHandlerRootView: 'GestureHandlerRootView'
}))

vi.mock('react-native-reanimated', () => ({
  default: { ScrollView: 'AnimatedScrollView', View: 'AnimatedView' },
  Extrapolation: { CLAMP: 'clamp' },
  interpolate: (_value: number, _input: number[], output: number[]) => output[1],
  runOnJS: (fn: () => void) => fn,
  useAnimatedScrollHandler: () => vi.fn(),
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useSharedValue: (value: number | boolean) => ({ value }),
  withSpring: (value: number) => value,
  withTiming: (value: number, _config: unknown, callback?: (finished: boolean) => void) => {
    animation.timingCallbacks.push(callback)
    return value
  }
}))

vi.mock('../layout/responsive-layout', () => ({
  useResponsiveLayout: () => ({ isWideLayout: false, modalMaxWidth: 640 })
}))

import { BottomDrawer } from './BottomDrawer'

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

describe('BottomDrawer exit animation', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    animation.timingCallbacks = []
    vi.restoreAllMocks()
  })

  it('reports hidden only after iOS dismisses the native modal', () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const onHidden = vi.fn()
    const renderDrawer = (visible: boolean, label: string) =>
      createElement(BottomDrawer, { visible, onClose: vi.fn(), onHidden }, label)
    const restoreWarning = suppressRendererWarning()
    try {
      act(() => {
        renderer = create(renderDrawer(true, 'source picker'))
      })
    } finally {
      restoreWarning()
    }
    animation.timingCallbacks = []

    act(() => {
      renderer?.update(renderDrawer(false, 'source picker'))
    })
    act(() => {
      renderer?.update(renderDrawer(false, 'source picker after parent refresh'))
    })

    const exitCallbacks = animation.timingCallbacks.filter(Boolean)
    expect(exitCallbacks).toHaveLength(1)
    act(() => exitCallbacks[0]?.(true))
    expect(renderer?.root.findByType('Modal').props.visible).toBe(false)
    expect(onHidden).not.toHaveBeenCalled()

    act(() => renderer?.root.findByType('Modal').props.onDismiss())
    expect(renderer?.root.findAllByType('Modal')).toHaveLength(0)
    expect(onHidden).toHaveBeenCalledTimes(1)
  })
})
