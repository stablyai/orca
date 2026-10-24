import { useRef, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileZoomableImagePreview } from '../files/MobileZoomableImagePreview'
import { MobileNativeChatImageViewer } from './MobileNativeChatImageViewer'

type Touch = {
  scale: number
  focalX: number
  focalY: number
  translationX: number
  translationY: number
  numberOfPointers: number
}
const gestures = vi.hoisted(() => new Map<string, Record<string, (event: Touch) => void>>())
vi.mock('react-native-gesture-handler', () => {
  const gesture = (kind: string) => {
    const handlers: Record<string, (event: Touch) => void> = {}
    gestures.set(kind, handlers)
    const chain = {
      enabled: () => chain,
      runOnJS: () => chain,
      maxPointers: () => chain,
      blocksExternalGesture: () => chain,
      onStart: (fn: (event: Touch) => void) => {
        handlers.start = fn
        return chain
      },
      onUpdate: (fn: (event: Touch) => void) => {
        handlers.update = fn
        return chain
      },
      onFinalize: (fn: (event: Touch) => void) => {
        handlers.finalize = fn
        return chain
      }
    }
    return chain
  }
  return {
    GestureHandlerRootView: 'GestureRoot',
    GestureDetector: ({ children }: { children: ReactNode }) => children,
    Gesture: {
      Native: () => gesture('native'),
      Pinch: () => gesture('pinch'),
      Pan: () => gesture('pan'),
      Simultaneous: (...items: unknown[]) => items
    }
  }
})
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  useSharedValue: (value: unknown) => useRef({ value }).current,
  useAnimatedStyle: (read: () => unknown) => read,
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn
}))
vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
  FlatList: 'FlatList',
  Modal: 'Modal',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles },
  useWindowDimensions: () => ({ width: 390, height: 844 })
}))
vi.mock('../layout/side-safe-area', () => ({
  useWindowSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 })
}))
vi.mock('lucide-react-native', () => ({ X: 'X' }))
vi.mock('./MobileNativeChatImage', () => ({ MobileNativeChatImage: 'Image' }))
let viewer: ReactTestRenderer | undefined
let page: ReactTestRenderer | undefined
afterEach(() => {
  act(() => {
    page?.unmount()
    viewer?.unmount()
  })
  vi.unstubAllGlobals()
})

it('zooms and pans in the phone page, then restores gallery swiping at the original scale', () => {
  act(() => {
    viewer = create(
      <MobileNativeChatImageViewer uri="file:///a.png" label="Screenshot" onClose={() => {}} />
    )
  })
  expect(viewer!.root.findAll((node) => String(node.type) === 'GestureRoot')).toHaveLength(1)
  const list = () => viewer!.root.find((node) => String(node.type) === 'FlatList')
  expect(list().props.scrollEnabled).toBe(true)
  act(() => list().props.onLayout({ nativeEvent: { layout: { height: 600 } } }))
  expect(list().props.renderItem({ item: { url: 'file:///a.png' }, index: 0 }).props.height).toBe(
    600
  )
  class PageElement {
    getBoundingClientRect() {
      return { left: 20, top: 60 }
    }
  }
  vi.stubGlobal('HTMLElement', PageElement)
  act(() => {
    page = create(list().props.renderItem({ item: { url: 'file:///a.png' }, index: 0 }), {
      createNodeMock: () => new PageElement()
    })
  })
  const viewport = page!.root.find((node) => String(node.type) === 'View')
  act(() => viewport.props.onLayout({ nativeEvent: { layout: { width: 390, height: 600 } } }))
  class BrowserImage {
    naturalWidth = 390
    naturalHeight = 600
  }
  vi.stubGlobal('HTMLImageElement', BrowserImage)
  act(() =>
    page!.root
      .find((node) => String(node.type) === 'Image')
      .props.onLoad({ nativeEvent: { target: new BrowserImage() } })
  )
  const event: Touch = {
    scale: 1,
    focalX: 215,
    focalY: 360,
    translationX: 0,
    translationY: 0,
    numberOfPointers: 1
  }
  act(() => gestures.get('pinch')?.start?.(event))
  expect(list().props.scrollEnabled).toBe(false)
  act(() => gestures.get('pinch')?.update?.({ ...event, scale: 2 }))
  act(() => gestures.get('pinch')?.finalize?.(event))
  const transform = () =>
    page!.root.find((node) => String(node.type) === 'AnimatedView').props.style[1]().transform
  expect(transform()).toEqual([{ translateX: 0 }, { translateY: 0 }, { scale: 2 }])
  expect(list().props.scrollEnabled).toBe(false)
  act(() => gestures.get('pan')?.start?.(event))
  act(() => gestures.get('pan')?.update?.({ ...event, translationX: 1000, translationY: -1000 }))
  expect(transform()).toEqual([{ translateX: 195 }, { translateY: -300 }, { scale: 2 }])
  act(() => gestures.get('pinch')?.start?.(event))
  act(() => gestures.get('pinch')?.update?.({ ...event, scale: 0.5 }))
  act(() => gestures.get('pinch')?.finalize?.(event))
  expect(transform()).toEqual([{ translateX: 0 }, { translateY: 0 }, { scale: 1 }])
  expect(list().props.scrollEnabled).toBe(true)
})

it('keeps the touched point anchored, caps enlargement, and clamps to the contained image', () => {
  act(() => {
    viewer = create(
      <MobileNativeChatImageViewer
        uri="file:///wide.png"
        label="Wide screenshot"
        onClose={() => {}}
      />
    )
  })
  const list = viewer!.root.find((node) => String(node.type) === 'FlatList')
  act(() => {
    page = create(list.props.renderItem({ item: { url: 'file:///wide.png' }, index: 0 }))
  })
  act(() =>
    page!.root
      .find((node) => String(node.type) === 'View')
      .props.onLayout({ nativeEvent: { layout: { width: 390, height: 600 } } })
  )
  act(() =>
    page!.root
      .find((node) => String(node.type) === 'Image')
      .props.onLoad({ nativeEvent: { source: { width: 780, height: 300 } } })
  )
  const event: Touch = {
    scale: 1,
    focalX: 245,
    focalY: 300,
    translationX: 0,
    translationY: 0,
    numberOfPointers: 1
  }
  act(() => gestures.get('pinch')?.start?.(event))
  act(() => gestures.get('pinch')?.update?.({ ...event, scale: 2 }))
  const transform = () =>
    page!.root.find((node) => String(node.type) === 'AnimatedView').props.style[1]().transform
  expect(transform()).toEqual([{ translateX: -50 }, { translateY: 0 }, { scale: 2 }])
  act(() => gestures.get('pinch')?.update?.({ ...event, scale: 10 }))
  expect(transform()[2]).toEqual({ scale: 4 })
  act(() => gestures.get('pinch')?.finalize?.(event))
  act(() => gestures.get('pan')?.start?.(event))
  act(() => gestures.get('pan')?.update?.({ ...event, translationY: 1000 }))
  expect(transform()[1]).toEqual({ translateY: 0 })
  act(() => page!.unmount())
  page = undefined
  expect(viewer!.root.find((node) => String(node.type) === 'FlatList').props.scrollEnabled).toBe(
    true
  )
})

it('rebases an already active pan after a pinch without overwriting the pinch or jumping', () => {
  act(() => {
    viewer = create(
      <MobileNativeChatImageViewer uri="file:///a.png" label="Screenshot" onClose={() => {}} />
    )
  })
  act(() => {
    page = create(
      viewer!.root
        .find((node) => String(node.type) === 'FlatList')
        .props.renderItem({ item: { url: 'file:///a.png' }, index: 0 })
    )
  })
  act(() =>
    page!.root
      .find((node) => String(node.type) === 'View')
      .props.onLayout({ nativeEvent: { layout: { width: 390, height: 600 } } })
  )
  const event: Touch = {
    scale: 1,
    focalX: 195,
    focalY: 300,
    translationX: 0,
    translationY: 0,
    numberOfPointers: 1
  }
  act(() => gestures.get('pinch')?.start?.(event))
  act(() => gestures.get('pinch')?.update?.({ ...event, scale: 2 }))
  act(() => gestures.get('pinch')?.finalize?.(event))
  act(() => gestures.get('pan')?.start?.(event))
  act(() => gestures.get('pan')?.update?.({ ...event, translationX: 40 }))
  act(() => gestures.get('pinch')?.start?.(event))
  act(() => gestures.get('pinch')?.update?.({ ...event, scale: 1.5 }))
  const transform = () =>
    page!.root.find((node) => String(node.type) === 'AnimatedView').props.style[1]().transform
  const afterPinch = transform()
  act(() => gestures.get('pan')?.start?.(event))
  act(() => gestures.get('pan')?.update?.({ ...event, translationX: 200, numberOfPointers: 2 }))
  expect(transform()).toEqual(afterPinch)
  act(() => gestures.get('pinch')?.finalize?.(event))
  act(() => gestures.get('pan')?.update?.({ ...event, translationX: 250 }))
  expect(transform()).toEqual(afterPinch)
  act(() => gestures.get('pan')?.update?.({ ...event, translationX: 260 }))
  expect(transform()[0]).toEqual({ translateX: 70 })
  act(() => gestures.get('pan')?.start?.(event))
  act(() => gestures.get('pan')?.update?.({ ...event, translationX: 10 }))
  expect(transform()[0]).toEqual({ translateX: 80 })
  expect(transform()[2]).toEqual({ scale: 3 })
})

it('zooms a file preview and resets its transform when the next file loads', () => {
  act(() => {
    page = create(
      <MobileZoomableImagePreview uri="data:image/png;base64,AAAA" label="Linked image" />
    )
  })
  act(() =>
    page!.root
      .find((node) => String(node.type) === 'View')
      .props.onLayout({ nativeEvent: { layout: { width: 390, height: 600 } } })
  )
  const viewport = page!.root.findAll((node) => String(node.type) === 'View').at(-1)!
  act(() => viewport.props.onLayout({ nativeEvent: { layout: { width: 390, height: 600 } } }))
  const event: Touch = {
    scale: 1,
    focalX: 195,
    focalY: 300,
    translationX: 0,
    translationY: 0,
    numberOfPointers: 2
  }
  act(() => gestures.get('pinch')?.start?.(event))
  act(() => gestures.get('pinch')?.update?.({ ...event, scale: 2 }))
  const transform = () =>
    page!.root.find((node) => String(node.type) === 'AnimatedView').props.style[1]().transform
  expect(transform()).toEqual([{ translateX: 0 }, { translateY: 0 }, { scale: 2 }])
  act(() =>
    page!.update(<MobileZoomableImagePreview uri="data:image/png;base64,BBBB" label="Next image" />)
  )
  expect(transform()).toEqual([{ translateX: 0 }, { translateY: 0 }, { scale: 1 }])
})
