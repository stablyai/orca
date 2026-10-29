import type { ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => {
  // Annotated rather than asserted: the literal alone narrows to 'ios' and the tests reassign it.
  const platform: { os: 'ios' | 'android' | 'web' } = { os: 'ios' }
  const remove = vi.fn()
  return {
    platform,
    remove,
    addEventListener: vi.fn((_event: string, _handler: () => boolean) => ({ remove }))
  }
})

vi.mock('react-native', () => ({
  BackHandler: {
    addEventListener: (event: string, handler: () => boolean) =>
      native.addEventListener(event, handler)
  },
  Keyboard: { dismiss: () => {} },
  get Platform() {
    return {
      OS: native.platform.os,
      select: (options: Record<string, unknown>) => options[native.platform.os] ?? options.default
    }
  },
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles, absoluteFillObject: {} },
  View: 'View',
  useWindowDimensions: () => ({ width: 390, height: 844 })
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 }),
  useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 })
}))
vi.mock('react-native-gesture-handler', () => {
  const chain: Record<string, unknown> = {}
  for (const method of ['activeOffsetX', 'simultaneousWithExternalGesture', 'onUpdate', 'onEnd']) {
    chain[method] = () => chain
  }
  return {
    Gesture: { Pan: () => chain, Native: () => chain },
    GestureDetector: 'GestureDetector',
    GestureHandlerRootView: 'GestureHandlerRootView'
  }
})
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView', ScrollView: 'AnimatedScrollView' },
  useSharedValue: (initial: number) => ({ value: initial }),
  useAnimatedStyle: () => ({}),
  useAnimatedScrollHandler: () => () => {},
  withSpring: (to: number) => to,
  withTiming: (to: number) => to,
  runOnJS: (fn: () => void) => fn,
  interpolate: () => 0,
  Extrapolation: { CLAMP: 'clamp' }
}))

import { RightDrawer } from './RightDrawer'

function DrawerBody(): null {
  return null
}

function drawer(visible: boolean, onClose: () => void = () => {}): ReactElement {
  return (
    <RightDrawer visible={visible} onClose={onClose}>
      <DrawerBody />
    </RightDrawer>
  )
}

function render(visible: boolean, onClose?: () => void): ReactTestRenderer {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(drawer(visible, onClose))
  })
  return renderer
}

beforeEach(() => {
  native.platform.os = 'ios'
  native.addEventListener.mockClear()
  native.remove.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// Drive native Back seam here; use-back-claim.web.ts tests page’s shell-handed Back claim.
describe('the right drawer and the phone hardware back button', () => {
  it('consumes an iOS hardware back press and closes the open drawer', () => {
    const onClose = vi.fn()
    const renderer = render(true, onClose)
    expect(native.addEventListener).toHaveBeenCalledTimes(1)
    expect(native.addEventListener.mock.calls[0]?.[0]).toBe('hardwareBackPress')
    const handler = native.addEventListener.mock.calls[0]![1]
    expect(onClose).not.toHaveBeenCalled()
    act(() => expect(handler()).toBe(true))
    expect(onClose).toHaveBeenCalledTimes(1)
    act(() => renderer.unmount())
  })

  it('releases it when the drawer hides', () => {
    const renderer = render(true)
    expect(native.remove).not.toHaveBeenCalled()
    act(() => renderer.update(drawer(false)))
    expect(native.remove).toHaveBeenCalledTimes(1)
    act(() => renderer.unmount())
  })

  // Page bundler selects web Back-claim sibling; component itself must not register native key there.
  it('releases it on unmount, so a drawer taken off screen leaves the key alone', () => {
    const renderer = render(true)
    act(() => renderer.unmount())
    expect(native.remove).toHaveBeenCalledTimes(1)
  })
})
