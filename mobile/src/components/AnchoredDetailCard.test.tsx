import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import { AnchoredDetailCardLayer } from './AnchoredDetailCard'
import type { AnchoredDetailCardState } from './use-anchored-detail-card'

const preference = vi.hoisted(() => ({ resolve: (_enabled: boolean) => {} }))
vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () =>
      new Promise<boolean>((resolve) => {
        preference.resolve = resolve
      }),
    addEventListener: () => ({ remove: () => {} })
  },
  Animated: {
    Value: class {
      stopAnimation(callback?: (value: number) => void) {
        callback?.(0)
      }
      interpolate() {
        return 'slide'
      }
    },
    View: 'AnimatedView',
    timing: () => ({ start: () => {} })
  },
  Easing: { out: (value: unknown) => value, cubic: 'cubic' },
  Platform: { OS: 'ios' },
  StyleSheet: { create: (value: unknown) => value, absoluteFillObject: {} },
  Text: 'Text',
  View: 'View',
  ScrollView: 'ScrollView'
}))
vi.mock('../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'light' }))

let renderer: ReactTestRenderer | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
})
const visual: NonNullable<AnchoredDetailCardState['visual']> = {
  anchor: { side: 'below', left: 20, top: 100, origin: { x: 0, y: 0 } },
  target: 1,
  motion: 1
}
const card = mountFixture<AnchoredDetailCardState>({
  visual: null,
  layerRef: { current: null },
  contentRef: { current: null },
  boundaryRefs: { current: [] },
  bounds: { left: 0, top: 0, right: 400, bottom: 800 },
  layerHeight: 800,
  onSettled: () => {},
  onLayout: () => {}
})
function render(open: boolean) {
  const node = createElement(AnchoredDetailCardLayer, {
    card: { ...card, visual: open ? visual : null, active: open },
    obscured: false,
    title: 'Workspace'
  })
  act(() => {
    if (renderer) {
      renderer.update(node)
    } else {
      renderer = create(node)
    }
  })
}
function transform() {
  const view = renderer!.root.findByProps({ role: 'dialog' })
  return Object.assign({}, ...view.props.style).transform
}

it('uses the resolved OS preference on the first visual mount and after reopening', async () => {
  render(false)
  await act(async () => {
    preference.resolve(false)
  })
  render(true)
  expect(transform()).toEqual([{ translateY: 'slide' }])
  render(false)
  render(true)
  expect(transform()).toEqual([{ translateY: 'slide' }])
})

it('keeps unknown and reduced motion fade-only', async () => {
  render(false)
  render(true)
  expect(transform()).toEqual([])
  await act(async () => {
    preference.resolve(true)
  })
  expect(transform()).toEqual([])
})
