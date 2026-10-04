import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
type Harness = {
  /** What `currentSoftKeyboardHeight()` answers: a keyboard already up when the sheet opens. */
  current: number
  show: ((height: number, duration: number) => void) | null
  hide: ((duration: number) => void) | null
  timings: { to: number; duration: number | undefined }[]
  /** Every shared-value write: a seed lands here directly, without a timing. */
  writes: number[]
}

const harness = vi.hoisted((): Harness => ({
  current: 0,
  show: null,
  hide: null,
  timings: [],
  writes: []
}))

vi.mock('../platform/keyboard-occlusion', () => ({
  currentSoftKeyboardHeight: () => harness.current,
  subscribeSoftKeyboard: (
    show: (height: number, duration: number) => void,
    hide: (duration: number) => void
  ) => {
    harness.show = show
    harness.hide = hide
    return () => {
      harness.show = null
      harness.hide = null
    }
  }
}))
vi.mock('../navigation/use-back-claim', () => ({ useBackClaim: () => {} }))
vi.mock('react-native', () => ({
  Keyboard: { dismiss: () => {} },
  Modal: 'Modal',
  Platform: { OS: 'android', select: (options: { android?: unknown }) => options.android },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T) => styles, absoluteFillObject: {} },
  View: 'View',
  useWindowDimensions: () => ({ width: 412, height: 900 })
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 })
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
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView', ScrollView: 'AnimatedScrollView' },
  useSharedValue: (initial: number) => {
    let value = initial
    return {
      get value() {
        return value
      },
      set value(next: number) {
        value = next
        harness.writes.push(next)
      }
    }
  },
  useAnimatedStyle: () => ({}),
  useAnimatedScrollHandler: () => () => {},
  withSpring: (to: number) => to,
  withTiming: (to: number, config?: { duration?: number }) => {
    harness.timings.push({ to, duration: config?.duration })
    return to
  },
  runOnJS: (fn: () => void) => fn,
  interpolate: () => 0,
  Extrapolation: { CLAMP: 'clamp' }
}))

import { MountedBottomDrawer } from './mounted-bottom-drawer'

function sheet(fillAvailable: boolean) {
  return (
    <MountedBottomDrawer
      visible
      fillAvailable={fillAvailable}
      onClose={() => {}}
      onHidden={() => {}}
    >
      {null}
    </MountedBottomDrawer>
  )
}

function render(fillAvailable: boolean): ReactTestRenderer {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(sheet(fillAvailable))
  })
  return renderer
}

function keyboardShows(height: number, duration: number): void {
  act(() => harness.show?.(height, duration))
}

function keyboardHides(duration: number): void {
  act(() => harness.hide?.(duration))
}

function marginBottom(renderer: ReactTestRenderer): unknown {
  const node = renderer.root.find((candidate) => candidate.props.testID === 'bottom-drawer-sheet')
  const style: unknown[] = [node.props.style].flat(Infinity)
  return Object.assign({}, ...style.filter((entry) => typeof entry === 'object' && entry !== null))
    .marginBottom
}

describe('the drawer riding the keyboard seam', () => {
  afterEach(() => {
    harness.current = 0
    harness.timings.length = 0
    harness.writes.length = 0
  })

  it('docks a fill sheet on a keyboard already up when it opens', () => {
    harness.current = 300
    const renderer = render(true)
    expect(marginBottom(renderer)).toBe(300)
    act(() => renderer.unmount())
  })

  it('does not seed a content-sized sheet from a keyboard already up', () => {
    harness.current = 300
    const renderer = render(false)
    expect(harness.writes).not.toContain(300)
    // It still rides the keyboard's next event.
    keyboardShows(310, 0)
    expect(harness.timings).toContainEqual({ to: 310, duration: 250 })
    act(() => renderer.unmount())
  })

  it('lifts with the event duration and drops back when the keyboard hides', () => {
    const renderer = render(true)
    keyboardShows(280, 120)
    expect(marginBottom(renderer)).toBe(280)
    expect(harness.timings).toContainEqual({ to: 280, duration: 120 })
    keyboardHides(0)
    expect(marginBottom(renderer)).toBe(0)
    // An event without a duration still animates.
    expect(harness.timings).toContainEqual({ to: 0, duration: 250 })
    act(() => renderer.unmount())
  })

  it('unsubscribes on unmount', () => {
    const renderer = render(true)
    expect(harness.show).not.toBeNull()
    act(() => renderer.unmount())
    expect(harness.show).toBeNull()
  })
})
