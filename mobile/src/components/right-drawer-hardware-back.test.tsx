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

function drawer(visible: boolean): ReactElement {
  return (
    <RightDrawer visible={visible} onClose={() => {}}>
      <DrawerBody />
    </RightDrawer>
  )
}

function render(visible: boolean): ReactTestRenderer {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(drawer(visible))
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

/**
 * The drawer claims the device Back key through one seam on both platforms. Here that seam is the
 * hardware key; inside the shell's page it is a claim the shell hands one press over on, which is
 * `use-back-claim.web.ts` and is tested there.
 */
describe('the right drawer and the phone hardware back button', () => {
  it('arms it on iOS while the drawer is open', () => {
    const renderer = render(true)
    expect(native.addEventListener).toHaveBeenCalledTimes(1)
    expect(native.addEventListener.mock.calls[0]?.[0]).toBe('hardwareBackPress')
    act(() => renderer.unmount())
  })

  it('arms it on Android while the drawer is open', () => {
    native.platform.os = 'android'
    const renderer = render(true)
    expect(native.addEventListener).toHaveBeenCalledTimes(1)
    act(() => renderer.unmount())
  })

  it('releases it when the drawer hides', () => {
    const renderer = render(true)
    expect(native.remove).not.toHaveBeenCalled()
    act(() => renderer.update(drawer(false)))
    expect(native.remove).toHaveBeenCalledTimes(1)
    act(() => renderer.unmount())
  })

  // Which module answers is the bundler's and not this component's: inside the page
  // `use-back-claim.web.ts` claims the key from the shell instead of registering here.
  it('releases it on unmount, so a drawer taken off screen leaves the key alone', () => {
    const renderer = render(true)
    act(() => renderer.unmount())
    expect(native.remove).toHaveBeenCalledTimes(1)
  })
})
