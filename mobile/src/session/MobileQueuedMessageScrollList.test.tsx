import { useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { findAllByHostType, findByHostType } from '../test-support/react-test-renderer-host-nodes'
import { MobileEdgeFade } from '../components/MobileEdgeFade'
import { colors, spacing } from '../theme/mobile-theme'
import { MobileQueuedMessageScrollList } from './MobileQueuedMessageScrollList'

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View'
}))
vi.mock('react-native-reanimated', () => ({
  default: { ScrollView: 'ScrollView' },
  useAnimatedRef: () => useRef(null),
  useSharedValue: (value: unknown) => useRef({ value }).current
}))

let renderer: ReactTestRenderer | null = null
afterEach(() => act(() => renderer?.unmount()))

it('keeps the queue edge cues, colors and dimensions with independent gradient references', () => {
  act(() => {
    renderer = create(
      <MobileQueuedMessageScrollList messageIds={['a']} newestIsPersons={false}>
        {() => 'queued body'}
      </MobileQueuedMessageScrollList>
    )
  })
  const tree = renderer!
  const scroll = findByHostType(tree.root, 'ScrollView')
  const fades = () => tree.root.findAllByType(MobileEdgeFade)
  expect(fades()).toHaveLength(0)
  act(() => scroll.props.onLayout({ nativeEvent: { layout: { height: 160 } } }))
  act(() => scroll.props.onContentSizeChange(0, 220))
  expect(fades().map((node) => node.props.edge)).toEqual(['bottom'])
  act(() => scroll.props.onScroll({ nativeEvent: { contentOffset: { y: 24 } } }))
  expect(fades().map((node) => node.props.edge)).toEqual(['top', 'bottom'])
  const ids = fades().map((fade) => {
    const overlay = findByHostType(fade, 'View')
    expect(overlay.props.pointerEvents).toBe('none')
    expect(Object.assign({}, ...overlay.props.style)).toMatchObject({
      position: 'absolute',
      left: 0,
      right: 0,
      height: spacing.lg
    })
    const gradient = findByHostType(fade, 'LinearGradient')
    expect(findByHostType(fade, 'Rect').props.fill).toBe(`url(#${gradient.props.id})`)
    return gradient.props.id
  })
  expect(new Set(ids).size).toBe(2)
  expect(
    fades().map((fade) =>
      findAllByHostType(fade, 'Stop').map((node) => [node.props.stopColor, node.props.stopOpacity])
    )
  ).toEqual([
    [
      [colors.bgPanel, 1],
      [colors.bgPanel, 0]
    ],
    [
      [colors.bgPanel, 0],
      [colors.bgPanel, 1]
    ]
  ])
  act(() => scroll.props.onScroll({ nativeEvent: { contentOffset: { y: 60 } } }))
  expect(fades().map((node) => node.props.edge)).toEqual(['top'])
  act(() => scroll.props.onContentSizeChange(0, 100))
  act(() => scroll.props.onScroll({ nativeEvent: { contentOffset: { y: 0 } } }))
  expect(fades()).toHaveLength(0)
})
