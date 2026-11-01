import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IMAGE_VIEWER_DISMISS_DISTANCE,
  IMAGE_VIEWER_DISMISS_VELOCITY
} from '../../../components/image-viewer-swipe'
import type { MobilePanZoomDismiss } from '../../../components/use-mobile-pan-zoom'

const motion = vi.hoisted(() => ({ reduced: false }))
const seen = vi.hoisted(() => ({
  dismiss: null as MobilePanZoomDismiss | null
}))

vi.mock('react-native', () => {
  class Value {
    setValue(): void {}
    interpolate(): this {
      return this
    }
  }
  const animation = () => ({
    start: (done?: (result: { finished: boolean }) => void) => done?.({ finished: true }),
    stop() {}
  })
  return {
    Animated: {
      Value,
      View: 'AnimatedView',
      timing: animation,
      spring: animation,
      multiply: (left: unknown) => left
    },
    Easing: { bezier: () => () => 0 },
    Modal: 'Modal',
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    StyleSheet: { create: (styles: unknown) => styles },
    useWindowDimensions: () => ({ width: 390, height: 844 })
  }
})
vi.mock('lucide-react-native', () => ({ X: 'X' }))
vi.mock('../../../layout/side-safe-area', () => ({
  useWindowSafeAreaInsets: () => ({ top: 12, right: 0, bottom: 21, left: 0 })
}))
vi.mock('../../../theme/use-mobile-color-scheme', () => ({
  useMobileColorScheme: () => 'dark'
}))
vi.mock('../../../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string) => fallback
}))
vi.mock('../../../components/MobilePanZoomImage', () => ({
  MobilePanZoomImage: (props: { dismiss?: MobilePanZoomDismiss | null }) => {
    seen.dismiss = props.dismiss ?? null
    return null
  }
}))
vi.mock('../../../platform/use-reduced-motion', () => ({
  useReducedMotionEnabled: () => motion.reduced
}))

import { MobileNativeChatImageViewer } from './MobileNativeChatImageViewer'

function render(onClose = vi.fn()): { onClose: ReturnType<typeof vi.fn> } {
  act(() => {
    create(
      createElement(MobileNativeChatImageViewer, {
        uri: 'file:///tmp/shot.png',
        label: 'shot',
        onClose
      })
    )
  })
  return { onClose }
}

function closeButton(renderer: ReactTestRenderer) {
  return renderer.root.findByProps({ accessibilityLabel: 'Close image' })
}

describe('MobileNativeChatImageViewer swipe dismiss', () => {
  beforeEach(() => {
    motion.reduced = false
    seen.dismiss = null
  })

  it('keeps the close button as the accessible way out', () => {
    let renderer: ReactTestRenderer | undefined
    const onClose = vi.fn()
    act(() => {
      renderer = create(
        createElement(MobileNativeChatImageViewer, {
          uri: 'file:///tmp/shot.png',
          label: 'shot',
          onClose
        })
      )
    })
    const button = closeButton(renderer!)
    expect(button.props.accessibilityRole).toBe('button')
    act(() => {
      button.props.onPress()
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes on a vertical release past the distance or a flick, from either direction', () => {
    const { onClose } = render()
    act(() => {
      seen.dismiss?.onRelease(IMAGE_VIEWER_DISMISS_DISTANCE, 0)
    })
    expect(onClose).toHaveBeenCalledOnce()

    const upward = render()
    act(() => {
      seen.dismiss?.onRelease(-IMAGE_VIEWER_DISMISS_DISTANCE, 0)
    })
    expect(upward.onClose).toHaveBeenCalledOnce()

    const flick = render()
    act(() => {
      seen.dismiss?.onRelease(24, IMAGE_VIEWER_DISMISS_VELOCITY)
    })
    expect(flick.onClose).toHaveBeenCalledOnce()
  })

  it('springs back when the finger stops short, including a flick back toward rest', () => {
    const { onClose } = render()
    act(() => {
      seen.dismiss?.onRelease(40, 0)
    })
    act(() => {
      seen.dismiss?.onRelease(220, -IMAGE_VIEWER_DISMISS_VELOCITY * 3)
    })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('still closes under Reduce Motion, by fading rather than refusing the swipe', () => {
    motion.reduced = true
    const { onClose } = render()
    act(() => {
      seen.dismiss?.onRelease(-IMAGE_VIEWER_DISMISS_DISTANCE, 0)
    })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
