import { createElement, useRef } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MountedBottomDrawer } from './mounted-bottom-drawer'

type KeyboardEvent = {
  duration: number
  endCoordinates: { height: number }
}

const keyboardListeners = vi.hoisted(() => new Map<string, (event: KeyboardEvent) => void>())

vi.mock('react-native', () => ({
  BackHandler: { addEventListener: () => ({ remove: vi.fn() }) },
  Keyboard: {
    addListener: (event: string, listener: (event: KeyboardEvent) => void) => {
      keyboardListeners.set(event, listener)
      return { remove: () => keyboardListeners.delete(event) }
    },
    dismiss: vi.fn(),
    metrics: () => undefined
  },
  Modal: 'Modal',
  Platform: { OS: 'ios', select: (styles: { ios?: unknown }) => styles.ios },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: {
    absoluteFillObject: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
    create: (styles: unknown) => styles
  },
  View: 'View',
  useWindowDimensions: () => ({ height: 844, width: 390 })
}))

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 34, left: 0, right: 0, top: 54 })
}))

vi.mock('react-native-gesture-handler', () => {
  function gesture() {
    const chain = {
      activeOffsetY: () => chain,
      onBegin: () => chain,
      onEnd: () => chain,
      onUpdate: () => chain,
      simultaneousWithExternalGesture: () => chain
    }
    return chain
  }
  return {
    Gesture: { Native: gesture, Pan: gesture },
    GestureDetector: 'GestureDetector',
    GestureHandlerRootView: 'GestureHandlerRootView'
  }
})

vi.mock('react-native-reanimated', () => ({
  default: { ScrollView: 'AnimatedScrollView', View: 'AnimatedView' },
  Extrapolation: { CLAMP: 'clamp' },
  interpolate: (value: number, input: number[], output: number[]) =>
    output[0]! + ((value - input[0]!) / (input[1]! - input[0]!)) * (output[1]! - output[0]!),
  runOnJS: (callback: (...args: unknown[]) => unknown) => callback,
  useAnimatedScrollHandler: () => vi.fn(),
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useSharedValue: (initial: number) => useRef({ value: initial }).current,
  withSpring: (value: number) => value,
  withTiming: (value: number, _config: unknown, completion?: (finished: boolean) => void) => {
    completion?.(true)
    return value
  }
}))

vi.mock('./bottom-drawer-modal-host', () => ({
  useInsideBottomDrawerModalHost: () => false
}))

vi.mock('../layout/responsive-layout', () => ({
  useResponsiveLayout: () => ({ isWideLayout: false, modalMaxWidth: 640 })
}))

function findDrawer(renderer: ReactTestRenderer): ReactTestInstance {
  const drawer = renderer.root.findAllByType('AnimatedView').find((node) => {
    const style = node.props.style
    return Array.isArray(style) && style.some((entry) => entry?.width === '100%')
  })
  if (!drawer) {
    throw new Error('Mounted drawer not found')
  }
  return drawer
}

function findStyleWith(
  drawer: ReactTestInstance,
  property: 'marginBottom' | 'transform'
): Record<string, unknown> {
  const style = drawer.props.style.findLast(
    (entry: Record<string, unknown> | null) => entry !== null && property in entry
  )
  if (!style) {
    throw new Error(`Drawer style missing ${property}`)
  }
  return style
}

describe('MountedBottomDrawer keyboard layout', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    keyboardListeners.clear()
    const originalConsoleError = console.error
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      originalConsoleError(...args)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('moves a content-sized drawer in layout so visual and native hit frames stay aligned', () => {
    let renderer: ReactTestRenderer | null = null
    act(() => {
      renderer = create(
        createElement(
          MountedBottomDrawer,
          { visible: true, onClose: vi.fn(), onHidden: vi.fn() },
          createElement('DrawerContent')
        )
      )
    })
    if (!renderer) {
      throw new Error('Mounted drawer did not render')
    }

    act(() => {
      keyboardListeners.get('keyboardWillShow')?.({
        duration: 250,
        endCoordinates: { height: 336 }
      })
    })

    const shownDrawer = findDrawer(renderer)
    expect(findStyleWith(shownDrawer, 'marginBottom').marginBottom).toBe(302)
    expect(findStyleWith(shownDrawer, 'transform').transform).toEqual([{ translateY: 0 }])

    act(() => {
      keyboardListeners.get('keyboardWillHide')?.({
        duration: 250,
        endCoordinates: { height: 0 }
      })
    })
    expect(findStyleWith(findDrawer(renderer), 'marginBottom').marginBottom).toBe(0)
    act(() => renderer.unmount())
  })

  it('preserves fill drawer height shrink and keyboard docking', () => {
    let renderer: ReactTestRenderer | null = null
    act(() => {
      renderer = create(
        createElement(
          MountedBottomDrawer,
          {
            fillAvailable: true,
            visible: true,
            onClose: vi.fn(),
            onHidden: vi.fn()
          },
          createElement('DrawerContent')
        )
      )
    })
    if (!renderer) {
      throw new Error('Fill drawer did not render')
    }

    act(() => {
      keyboardListeners.get('keyboardWillShow')?.({
        duration: 250,
        endCoordinates: { height: 336 }
      })
    })

    const style = findDrawer(renderer).props.style
    expect(style[2]).toMatchObject({ height: 438, marginBottom: 336, paddingBottom: 8 })
    expect(
      style.filter((entry: Record<string, unknown> | null) => entry?.marginBottom != null)
    ).toHaveLength(1)
    expect(findStyleWith(findDrawer(renderer), 'transform').transform).toEqual([{ translateY: 0 }])

    act(() => {
      keyboardListeners.get('keyboardWillHide')?.({
        duration: 250,
        endCoordinates: { height: 0 }
      })
    })

    const hiddenStyle = findDrawer(renderer).props.style
    expect(hiddenStyle[2]).toMatchObject({ height: 774, marginBottom: 0, paddingBottom: 50 })
    act(() => renderer.unmount())
  })
})
