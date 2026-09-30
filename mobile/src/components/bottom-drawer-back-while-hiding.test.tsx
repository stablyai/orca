import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Timing = { to: number; callback?: (finished: boolean) => void }

// Models Reanimated's contract: assigning a new animation cancels the running one,
// whose callback then gets finished=false.
const animations = vi.hoisted((): { running: Timing[] } => ({ running: [] }))

vi.mock('../navigation/use-back-claim', () => ({ useBackClaim: () => {} }))
vi.mock('../platform/keyboard-occlusion', () => ({
  currentSoftKeyboardHeight: () => 0,
  subscribeSoftKeyboard: () => () => {}
}))
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
vi.mock('react-native-reanimated', () => {
  function isTiming(value: unknown): value is Timing {
    return typeof value === 'object' && value !== null && 'to' in value
  }
  return {
    default: { View: 'AnimatedView', ScrollView: 'AnimatedScrollView' },
    useSharedValue: (initial: number) => {
      let value = initial
      let current: Timing | null = null
      return {
        get value() {
          return value
        },
        set value(next: unknown) {
          if (current) {
            const cancelled = current
            current = null
            animations.running = animations.running.filter((entry) => entry !== cancelled)
            cancelled.callback?.(false)
          }
          if (isTiming(next)) {
            current = next
            animations.running.push(next)
            value = next.to
          } else if (typeof next === 'number') {
            value = next
          }
        }
      }
    },
    useAnimatedStyle: () => ({}),
    useAnimatedScrollHandler: () => () => {},
    withSpring: (to: number) => to,
    withTiming: (to: number, _config?: unknown, callback?: (finished: boolean) => void) => ({
      to,
      callback
    }),
    runOnJS: (fn: () => void) => fn,
    interpolate: () => 0,
    Extrapolation: { CLAMP: 'clamp' }
  }
})

import { MountedBottomDrawer } from './mounted-bottom-drawer'

function finishAnimations(): void {
  const finishing = animations.running
  animations.running = []
  act(() => {
    for (const animation of finishing) {
      animation.callback?.(true)
    }
  })
}

function drawer(visible: boolean, onClose: () => void, onHidden: () => void) {
  return (
    <MountedBottomDrawer visible={visible} onClose={onClose} onHidden={onHidden}>
      {null}
    </MountedBottomDrawer>
  )
}

function pressAndroidBack(renderer: ReactTestRenderer): void {
  act(() => renderer.root.find((node) => String(node.type) === 'Modal').props.onRequestClose())
}

describe('bottom drawer close request while hiding', () => {
  afterEach(() => {
    animations.running = []
  })

  it('still closes an open drawer on Android Back', () => {
    const onClose = vi.fn()
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(drawer(true, onClose, vi.fn()))
    })
    finishAnimations()

    pressAndroidBack(renderer)
    finishAnimations()

    expect(onClose).toHaveBeenCalledTimes(1)
    act(() => renderer.unmount())
  })

  // A Back press inside the hide animation used to restart it, so onHidden never fired
  // and the drawer's invisible Modal stayed up, swallowing every tap on the screen.
  it('lets the hide finish when Back is pressed mid-close', () => {
    const onClose = vi.fn()
    const onHidden = vi.fn()
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(drawer(true, onClose, onHidden))
    })
    finishAnimations()
    act(() => renderer.update(drawer(false, onClose, onHidden)))

    pressAndroidBack(renderer)
    finishAnimations()

    expect(onHidden).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })
})
