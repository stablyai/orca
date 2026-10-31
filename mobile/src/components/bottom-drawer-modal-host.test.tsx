import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Timing = { to: number; callback?: (finished: boolean) => void }

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
vi.mock('./AutoHeight', () => ({ AutoHeight: ({ children }: { children: unknown }) => children }))
vi.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (t: number) => t },
  default: { View: 'AnimatedView', ScrollView: 'AnimatedScrollView' },
  useSharedValue: (initial: number) => ({ value: initial }),
  useAnimatedStyle: () => ({}),
  useAnimatedScrollHandler: () => () => {},
  withSpring: (to: number) => to,
  withTiming: (to: number, _config?: unknown, callback?: (finished: boolean) => void) => {
    animations.running.push({ to, callback })
    return to
  },
  runOnJS: (fn: () => void) => fn,
  interpolate: () => 0,
  Extrapolation: { CLAMP: 'clamp' }
}))

import { BottomDrawer } from './BottomDrawer'
import { BottomDrawerModalHost } from './bottom-drawer-modal-host'

function finishAnimations(): void {
  const finishing = animations.running
  animations.running = []
  act(() => {
    for (const animation of finishing) {
      animation.callback?.(true)
    }
  })
}

type Layers = { detail: boolean; form: boolean }

const closeDetail = vi.fn()
const closeForm = vi.fn()

// Mirror Tasks: form precedes detail in tree but zIndex raises it, both under one host.
function tasksSheets({ detail, form }: Layers) {
  return (
    <BottomDrawerModalHost>
      <BottomDrawer visible={form} onClose={closeForm} zIndex={1100}>
        {createElement('Sheet', { name: 'form' })}
      </BottomDrawer>
      <BottomDrawer visible={detail} onClose={closeDetail}>
        {createElement('Sheet', { name: 'detail' })}
      </BottomDrawer>
    </BottomDrawerModalHost>
  )
}

let rendered: ReactTestRenderer | null = null

function show(layers: Layers): void {
  act(() => {
    if (rendered) {
      rendered.update(tasksSheets(layers))
    } else {
      rendered = create(tasksSheets(layers))
    }
  })
}

function nativeModals() {
  return rendered?.root.findAll((node) => String(node.type) === 'Modal') ?? []
}

function sheetsInModal(): string[] {
  return nativeModals().flatMap((modal) =>
    modal.findAll((node) => String(node.type) === 'Sheet').map((sheet) => String(sheet.props.name))
  )
}

function pressAndroidBack(): void {
  act(() => nativeModals()[0]?.props.onRequestClose())
  finishAnimations()
}

describe('BottomDrawerModalHost without a caller-owned visible', () => {
  afterEach(() => {
    act(() => rendered?.unmount())
    rendered = null
    animations.running = []
    closeDetail.mockReset()
    closeForm.mockReset()
  })

  // iOS rejects sibling modal over active issue detail (#21003); Create form and detail must share one Modal.
  it('opens a sheet over another inside the one native Modal', () => {
    show({ detail: true, form: false })
    finishAnimations()
    show({ detail: true, form: true })

    expect(nativeModals()).toHaveLength(1)
    expect(sheetsInModal().sort()).toEqual(['detail', 'form'])
  })

  it('keeps the Modal through the last close animation, then leaves none to swallow taps', () => {
    show({ detail: true, form: true })
    finishAnimations()

    show({ detail: true, form: false })
    finishAnimations()
    expect(sheetsInModal()).toEqual(['detail'])

    show({ detail: false, form: false })
    expect(sheetsInModal()).toEqual(['detail'])
    finishAnimations()
    expect(nativeModals()).toHaveLength(0)
  })

  it('hands Back to the sheet on top, then to the one under it', () => {
    show({ detail: true, form: false })
    finishAnimations()
    show({ detail: true, form: true })
    finishAnimations()

    pressAndroidBack()
    expect(closeForm).toHaveBeenCalledTimes(1)
    expect(closeDetail).not.toHaveBeenCalled()

    show({ detail: true, form: false })
    finishAnimations()
    pressAndroidBack()
    expect(closeDetail).toHaveBeenCalledTimes(1)
  })
})
