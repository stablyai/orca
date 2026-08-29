import { createElement, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const withTimingCalls = vi.hoisted(() => [] as { to: number; duration: number | undefined }[])
const sharedWrites = vi.hoisted(() => [] as { key: string; value: unknown }[])

vi.mock('react-native', () => ({
  BackHandler: { addEventListener: () => ({ remove: () => {} }) },
  Keyboard: {
    addListener: () => ({ remove: () => {} }),
    dismiss: () => {},
    metrics: () => null
  },
  Modal: 'Modal',
  Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: {
    create: <T>(styles: T) => styles,
    absoluteFillObject: {}
  },
  View: 'View',
  useWindowDimensions: () => ({ width: 440, height: 956 })
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 })
}))
vi.mock('react-native-gesture-handler', () => {
  const chain: Record<string, unknown> = {}
  for (const method of [
    'activeOffsetY',
    'simultaneousWithExternalGesture',
    'onBegin',
    'onUpdate',
    'onEnd'
  ]) {
    chain[method] = () => chain
  }
  return {
    Gesture: { Pan: () => chain, Native: () => chain },
    GestureDetector: 'GestureDetector',
    GestureHandlerRootView: 'GestureHandlerRootView'
  }
})
vi.mock('react-native-reanimated', () => {
  function makeShared(key: string, initial: number) {
    let value = initial
    return {
      get value() {
        return value
      },
      set value(next: number) {
        value = next
        sharedWrites.push({ key, value: next })
      }
    }
  }
  let sharedIndex = 0
  return {
    default: { View: 'AnimatedView', ScrollView: 'AnimatedScrollView' },
    useSharedValue: (initial: number) => makeShared(`shared-${sharedIndex++}`, initial),
    useAnimatedStyle: () => ({}),
    useAnimatedScrollHandler: () => () => {},
    withSpring: (to: number) => to,
    withTiming: (to: number, config?: { duration?: number }) => {
      withTimingCalls.push({ to, duration: config?.duration })
      return to
    },
    runOnJS: (fn: () => void) => fn,
    interpolate: () => 0,
    Extrapolation: { CLAMP: 'clamp' }
  }
})

import { MountedBottomDrawer } from './mounted-bottom-drawer'

const noop = () => {}

// Counts mounts of the sheet's CONTENT, so a test can tell an ordinary re-render
// apart from the subtree rebuild the fix relies on to repaint a stale native view.
const sheetBodyMounts = { count: 0 }
function SheetBody() {
  useEffect(() => {
    sheetBodyMounts.count += 1
  }, [])
  return null
}

function drawer(interactive: boolean) {
  return createElement(
    MountedBottomDrawer,
    { visible: true, interactive, onClose: noop, onHidden: noop },
    createElement(SheetBody)
  )
}

function render(interactive: boolean): ReactTestRenderer {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(drawer(interactive))
  })
  return renderer
}

function update(renderer: ReactTestRenderer, interactive: boolean): void {
  act(() => {
    renderer.update(drawer(interactive))
  })
}

// A sheet pinned under a fill picker keeps progress at 1 the whole time, so
// nothing re-applies its enter transform when the picker gives the window back.
// On device that left the create form laid out but unpainted — a dimmed screen
// with no sheet and no way back except dismissing the whole modal.
describe('bottom drawer window hand-back', () => {
  afterEach(() => {
    withTimingCalls.length = 0
    sharedWrites.length = 0
    sheetBodyMounts.count = 0
  })

  it('re-asserts the enter transform when a pinned sheet takes the window back', () => {
    const renderer = render(true)
    update(renderer, false)
    const beforeHandback = withTimingCalls.filter((call) => call.to === 1).length

    update(renderer, true)

    expect(withTimingCalls.filter((call) => call.to === 1).length).toBe(beforeHandback + 1)
    act(() => renderer.unmount())
  })

  // Shared-value writes cannot heal a sheet whose native view was rebuilt under
  // Reanimated (verified on device); only a fresh view repaints. Counting content
  // mounts asserts the subtree actually rebuilt, not merely that a prop changed.
  it('rebuilds the sheet subtree when it takes the window back', () => {
    const renderer = render(true)
    update(renderer, false)
    const mountsWhilePinned = sheetBodyMounts.count
    expect(mountsWhilePinned).toBe(1)

    update(renderer, true)

    expect(sheetBodyMounts.count).toBe(2)
    act(() => renderer.unmount())
  })

  it('does not re-assert or rebuild while the sheet stays pinned', () => {
    const renderer = render(true)
    update(renderer, false)
    const pinned = withTimingCalls.filter((call) => call.to === 1).length

    update(renderer, false)

    expect(withTimingCalls.filter((call) => call.to === 1).length).toBe(pinned)
    expect(sheetBodyMounts.count).toBe(1)
    act(() => renderer.unmount())
  })
})
