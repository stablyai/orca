import { probe, publishLayout, mounted, positions } from './drag-reorder-test-harness.test-fixture'
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import Animated, { useAnimatedRef, useSharedValue } from 'react-native-reanimated'
import { expect, it, vi } from 'vitest'
import { DragReorderList } from './DragReorderList'

it('places a coherent measured append directly, but springs a dragged row back into its slot', async () => {
  function Harness({ ids }: { ids: string[] }) {
    return createElement(DragReorderList<string>, {
      items: ids,
      itemKey: (id) => id,
      renderRow: (id, handle) => createElement('Text', null, id, handle),
      scrollRef: useAnimatedRef<Animated.ScrollView>(),
      scrollOffsetY: useSharedValue(0),
      scrollContentHeight: useSharedValue(200)
    })
  }
  let root: ReturnType<typeof create>
  await act(async () => {
    root = create(createElement(Harness, { ids: ['a', 'b'] }))
  })
  const rows = () =>
    root!.root.findAll((node) => node.type === Animated.View && node.props.onLayout)
  const measureRow = (at: number) =>
    rows()[at]!.props.onLayout({ nativeEvent: { layout: { height: 44 } } })
  const frame = () => {
    probe.reactions.forEach((react) => react())
    return [...probe.styles.values()].map((read) => read())
  }
  await act(async () => {
    measureRow(0)
    measureRow(1)
  })
  await publishLayout()
  expect(frame().map((style) => style.top)).toEqual([0, 44])
  expect(probe.spring).not.toHaveBeenCalled()
  await act(async () => root!.update(createElement(Harness, { ids: ['a', 'b', 'c'] })))
  expect(frame().map((style) => [style.position, style.top])).toEqual([
    ['relative', 0],
    ['relative', 0],
    ['relative', 0]
  ])
  const measurement = probe.shared.find(
    (held) => held.value && typeof held.value === 'object' && 'sizes' in held.value
  )!
  const earlier = measurement.value
  await act(async () => measureRow(2))
  await publishLayout()
  const coherent = measurement.value
  // React is ready, but the UI thread still has the previous measurement publication.
  measurement.value = earlier
  expect(frame().every((style) => style.position === 'relative' && style.top === 0)).toBe(true)
  measurement.value = coherent
  expect(frame().map((style) => [style.position, style.top])).toEqual([
    ['absolute', 0],
    ['absolute', 44],
    ['absolute', 88]
  ])
  expect(probe.spring).not.toHaveBeenCalled()
  const gesture = probe.gestures.at(-2)!
  await act(async () => {
    gesture.start!({ absoluteY: 60, translationY: 0 }, true)
    gesture.update!({ absoluteY: 70, translationY: 10 }, true)
  })
  expect(frame()[1]!.top).toBe(54)
  await act(async () => gesture.finalize!({ absoluteY: 70, translationY: 10 }, true))
  expect(frame()[1]!.top).toBe(44)
  expect(probe.spring).toHaveBeenCalledExactlyOnceWith(44, expect.any(Object))
  await act(async () => root!.unmount())
})

it('asks synchronous admission before changing positions and restores a refused dragged proposal', async () => {
  const onMove = vi.fn(() => true)
  const fixture = await mounted({ initialIds: ['a', 'b', 'c'], onMove })
  const handle = fixture.root.root.findAll(
    (node) => node.type === Animated.View && node.props.onAccessibilityAction
  )[0]!
  const moveDown = () =>
    handle.props.onAccessibilityAction({ nativeEvent: { actionName: 'moveDown' } })
  await act(async () => moveDown())
  expect(positions()).toEqual({ a: 1, b: 0, c: 2 })
  onMove.mockReturnValue(false)
  const displayed = positions()
  await act(async () => moveDown())
  expect(positions()).toBe(displayed)
  expect(fixture.onReorder).toHaveBeenCalledTimes(1)
  await act(async () => {
    fixture.gesture.start!({ absoluteY: 100, translationY: 0 }, true)
    fixture.gesture.update!({ absoluteY: 200, translationY: 100 }, true)
    fixture.gesture.finalize!({ absoluteY: 200, translationY: 100 }, true)
  })
  expect(positions()).toEqual(displayed)
  expect(fixture.onReorder).toHaveBeenCalledTimes(1)
  await act(async () => fixture.root.unmount())
})

it('retains every disabled grip and layout, including mail', async () => {
  const move = vi.fn()
  function Harness({ disabled }: { disabled: boolean }) {
    return createElement(DragReorderList<string>, {
      items: ['a', 'mail', 'b'],
      itemKey: (id) => id,
      isMoveDisabled: () => disabled,
      rowHeight: 56,
      rowPresentation: 'plain',
      onMove: move,
      renderRow: (id, handle) => createElement('Text', null, id, handle),
      scrollRef: useAnimatedRef<Animated.ScrollView>(),
      scrollOffsetY: useSharedValue(0),
      scrollContentHeight: useSharedValue(168)
    })
  }
  let root: ReturnType<typeof create>
  await act(async () => {
    root = create(createElement(Harness, { disabled: false }))
  })
  const handles = () =>
    root!.root.findAll((node) => node.type === Animated.View && node.props.onAccessibilityAction)
  const first = handles()[0]!
  expect(handles()).toHaveLength(3)
  await act(async () => root!.update(createElement(Harness, { disabled: true })))
  expect(handles()[0]).toBe(first)
  expect(handles().every((handle) => handle.props.accessibilityState.disabled)).toBe(true)
  expect(probe.enabled.slice(-3)).toEqual([false, false, false])
  await act(async () =>
    first.props.onAccessibilityAction({ nativeEvent: { actionName: 'moveDown' } })
  )
  expect(move).not.toHaveBeenCalled()
  await act(async () => root!.update(createElement(Harness, { disabled: false })))
  expect(handles()[0]).toBe(first)
  expect(probe.enabled.slice(-3)).toEqual([true, true, true])
  await act(async () =>
    first.props.onAccessibilityAction({ nativeEvent: { actionName: 'moveDown' } })
  )
  expect(move).toHaveBeenCalledExactlyOnceWith({ movedId: 'a', beforeId: 'b' })
  expect(positions()).toEqual({ a: 1, mail: 0, b: 2 })
  await act(async () => root!.unmount())
})
