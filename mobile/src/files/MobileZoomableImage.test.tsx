import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const gestureSeams = vi.hoisted(() => ({
  composed: [] as string[]
}))

vi.mock('react-native', () => ({
  Image: 'Image',
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: 'View'
}))
vi.mock('react-native-gesture-handler', () => {
  const chain: Record<string, unknown> = {}
  for (const method of ['numberOfTaps', 'onBegin', 'onEnd', 'onFinalize', 'onUpdate']) {
    chain[method] = () => chain
  }
  return {
    Gesture: {
      Pan: () => chain,
      Pinch: () => chain,
      Simultaneous: (...gestures: unknown[]) => {
        gestureSeams.composed.push(`simultaneous:${gestures.length}`)
        return chain
      },
      Tap: () => chain
    },
    GestureDetector: 'GestureDetector',
    GestureHandlerRootView: 'GestureHandlerRootView'
  }
})
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  useAnimatedStyle: () => ({}),
  useSharedValue: <T,>(initial: T) => ({ value: initial }),
  withSpring: (value: number) => value
}))

import { MobileZoomableImage } from './MobileZoomableImage'

let mounted: ReactTestRenderer | null = null

afterEach(() => {
  mounted?.unmount()
  mounted = null
  gestureSeams.composed.length = 0
})

function findAllTyped(root: ReactTestRenderer, type: string): ReactTestInstance[] {
  return root.root.findAll((node) => node.type === type)
}

function renderImage(): ReactTestRenderer {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(
      createElement(MobileZoomableImage, {
        dataUri: 'data:image/png;base64,QUJD',
        width: 358,
        height: 684,
        title: 'shot',
        onImageError: () => undefined
      })
    )
    mounted = renderer
  })
  return renderer
}

describe('MobileZoomableImage', () => {
  it('renders the image inside the gesture detector with the given frame', () => {
    const renderer = renderImage()
    const images = findAllTyped(renderer, 'Image')
    expect(images).toHaveLength(1)
    expect(images[0].props.accessibilityLabel).toBe('shot image')
    expect(images[0].props.style).toMatchObject([
      { backgroundColor: expect.any(String) },
      { width: 358, height: 684 }
    ])
    expect(findAllTyped(renderer, 'GestureHandlerRootView')).toHaveLength(1)
    expect(findAllTyped(renderer, 'GestureDetector')).toHaveLength(1)
    expect(findAllTyped(renderer, 'AnimatedView')).toHaveLength(1)
  })

  it('composes pinch, pan, and double-tap as simultaneous gestures', () => {
    renderImage()
    expect(gestureSeams.composed).toEqual(['simultaneous:3'])
  })
})
