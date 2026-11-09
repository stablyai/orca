import { probe, publishLayout, mounted, positions } from './drag-reorder-test-harness.test-fixture'
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import Animated, { useAnimatedRef, useSharedValue } from 'react-native-reanimated'
import { describe, expect, it, vi } from 'vitest'
import { DragReorderList } from './DragReorderList'
import { GripVertical } from 'lucide-react-native'

import { queuedMessageStyles } from '../session/native-chat/input/mobile-native-chat-queued-message-styles'
import { spacing } from '../theme/mobile-theme'

describe('drag completion and cancellation', () => {
  it('restores original positions and writes nothing when an active drag is cancelled', async () => {
    const fixture = await mounted()
    await act(async () => {
      fixture.gesture.start!({ absoluteY: 100, translationY: 0 }, true)
      fixture.gesture.update!({ absoluteY: 180, translationY: 80 }, true)
    })
    expect(positions()).toEqual({ a: 1, b: 0 })
    await act(async () => fixture.gesture.finalize!({ absoluteY: 180, translationY: 80 }, false))
    expect(positions()).toEqual({ a: 0, b: 1 })
    expect(fixture.onReorder).not.toHaveBeenCalled()
    expect(fixture.onActive.mock.calls).toEqual([[true], [false]])
    expect(probe.frameActive).toHaveBeenLastCalledWith(false)
    await act(async () => fixture.root.unmount())
  })

  it('does not write after a failed activation or an unchanged drop', async () => {
    const fixture = await mounted()
    await act(async () => {
      fixture.gesture.finalize!({ absoluteY: 100, translationY: 0 }, false)
      fixture.gesture.start!({ absoluteY: 100, translationY: 0 }, true)
      fixture.gesture.finalize!({ absoluteY: 100, translationY: 0 }, true)
    })
    expect(fixture.onReorder).not.toHaveBeenCalled()
    await act(async () => fixture.root.unmount())
  })

  it.each([
    { ids: ['a', 'fixed'], distance: 80, expected: { a: 0, fixed: 1 }, changed: false },
    { ids: ['a', 'fixed', 'b'], distance: 80, expected: { a: 0, fixed: 1, b: 2 }, changed: false },
    { ids: ['a', 'fixed', 'b'], distance: 160, expected: { b: 0, fixed: 1, a: 2 }, changed: true }
  ])('settles a drag across excluded slots at $distance with $ids', async (test) => {
    const onMove = vi.fn()
    const fixture = await mounted({
      initialIds: test.ids,
      canMove: (item) => item.id !== 'fixed',
      onMove
    })
    await act(async () => {
      fixture.gesture.start!({ absoluteY: 100, translationY: 0 }, true)
      fixture.gesture.update!({ absoluteY: 100 + test.distance, translationY: test.distance }, true)
    })
    expect(positions()).not.toEqual(test.expected)
    await act(async () =>
      fixture.gesture.finalize!(
        { absoluteY: 100 + test.distance, translationY: test.distance },
        true
      )
    )
    expect(positions()).toEqual(test.expected)
    if (test.changed) {
      expect(onMove).toHaveBeenCalledExactlyOnceWith({ movedId: 'a', afterId: 'b' })
      await fixture.updateItems(['b', 'fixed', 'a'])
      await fixture.updateItems(test.ids)
      expect(positions()).toEqual({ a: 0, fixed: 1, b: 2 })
    } else {
      expect(onMove).not.toHaveBeenCalled()
      expect(fixture.onReorder).not.toHaveBeenCalled()
    }
    await act(async () => fixture.root.unmount())
  })
})

describe('catalog changes during a drag', () => {
  it('releases the scroll lock when the held row disappears and ignores its late cancellation', async () => {
    const fixture = await mounted()
    await act(async () => {
      fixture.gesture.start!({ absoluteY: 100, translationY: 0 }, true)
      fixture.gesture.update!({ absoluteY: 180, translationY: 80 }, true)
    })
    await fixture.updateItems(['b', 'c'])
    expect(fixture.onActive.mock.calls).toEqual([[true], [false]])
    expect(probe.frameActive).toHaveBeenLastCalledWith(false)
    await act(async () => fixture.gesture.finalize!({ absoluteY: 180, translationY: 80 }, false))
    expect(
      probe.shared.some(
        (held) =>
          held.value &&
          typeof held.value === 'object' &&
          'b' in held.value &&
          'c' in held.value &&
          !('a' in held.value)
      )
    ).toBe(true)
    expect(fixture.onReorder).not.toHaveBeenCalled()
    await act(async () => fixture.root.unmount())
  })

  it.each([{ ids: ['a', 'b', 'c'] }, { ids: ['b', 'a'] }])(
    'does not commit a stale drag after the catalog becomes $ids',
    async ({ ids }) => {
      const fixture = await mounted()
      await act(async () => {
        fixture.gesture.start!({ absoluteY: 100, translationY: 0 }, true)
        fixture.gesture.update!({ absoluteY: 180, translationY: 80 }, true)
      })
      await fixture.updateItems(ids)
      await act(async () => fixture.gesture.finalize!({ absoluteY: 180, translationY: 80 }, true))
      expect(fixture.onReorder).not.toHaveBeenCalled()
      expect(fixture.onActive.mock.calls).toEqual([[true], [false]])
      await act(async () => fixture.root.unmount())
    }
  )

  it('releases its owner when unmounted while a row is held', async () => {
    const fixture = await mounted()
    await act(async () => fixture.gesture.start!({ absoluteY: 100, translationY: 0 }, true))
    await act(async () => fixture.root.unmount())
    expect(fixture.onActive.mock.calls).toEqual([[true], [false]])
    expect(probe.frameActive).toHaveBeenLastCalledWith(false)
    expect(fixture.onReorder).not.toHaveBeenCalled()
  })

  it('keeps a drag when only row metadata refreshes', async () => {
    const fixture = await mounted()
    await act(async () => {
      fixture.gesture.start!({ absoluteY: 100, translationY: 0 }, true)
      fixture.gesture.update!({ absoluteY: 180, translationY: 80 }, true)
    })
    await fixture.updateItems(['a', 'b'])
    expect(fixture.onActive.mock.calls).toEqual([[true]])
    probe.deferJS = true
    await act(async () => fixture.gesture.finalize!({ absoluteY: 180, translationY: 80 }, true))
    await fixture.updateItems(['a', 'b'])
    await act(async () => {
      probe.jsQueue.splice(0).forEach((fn) => fn())
    })
    expect(fixture.onReorder.mock.calls).toEqual([[['b', 'a']]])
    await act(async () => fixture.root.unmount())
  })
})

describe('late gesture callbacks', () => {
  it('ignores movement delivered after the row catalog changes', async () => {
    const fixture = await mounted()
    await act(async () => fixture.gesture.start!({ absoluteY: 100, translationY: 0 }, true))
    await fixture.updateItems(['a', 'b', 'c'])
    await act(async () => fixture.gesture.update!({ absoluteY: 180, translationY: 80 }, true))
    expect(positions()).toEqual({ a: 0, b: 1, c: 2 })
    expect(fixture.onReorder).not.toHaveBeenCalled()
    await act(async () => fixture.root.unmount())
  })

  it.each([
    ['a', 'b', 'c'],
    ['b', 'a']
  ])('does not save a completed drop queued before catalog %j replaces it', async (...ids) => {
    const fixture = await mounted()
    await act(async () => {
      fixture.gesture.start!({ absoluteY: 100, translationY: 0 }, true)
      fixture.gesture.update!({ absoluteY: 180, translationY: 80 }, true)
      probe.deferJS = true
      fixture.gesture.finalize!({ absoluteY: 180, translationY: 80 }, true)
    })
    await fixture.updateItems(ids)
    await act(async () => {
      probe.jsQueue.splice(0).forEach((fn) => fn())
    })
    expect(fixture.onReorder).not.toHaveBeenCalled()
    await act(async () => fixture.root.unmount())
  })

  it('does not revive a queued drop when the original row order returns', async () => {
    const fixture = await mounted()
    await act(async () => {
      fixture.gesture.start!({ absoluteY: 100, translationY: 0 }, true)
      fixture.gesture.update!({ absoluteY: 180, translationY: 80 }, true)
      probe.deferJS = true
      fixture.gesture.finalize!({ absoluteY: 180, translationY: 80 }, true)
    })
    await fixture.updateItems(['b', 'a'])
    await fixture.updateItems(['a', 'b'])
    await act(async () => {
      probe.jsQueue.splice(0).forEach((fn) => fn())
    })
    expect(fixture.onReorder).not.toHaveBeenCalled()
    expect(positions()).toEqual({ a: 0, b: 1 })
    await act(async () => fixture.root.unmount())
  })

  it('does not save a completed drop after unmount', async () => {
    const fixture = await mounted()
    await act(async () => {
      fixture.gesture.start!({ absoluteY: 100, translationY: 0 }, true)
      fixture.gesture.update!({ absoluteY: 180, translationY: 80 }, true)
      probe.deferJS = true
      fixture.gesture.finalize!({ absoluteY: 180, translationY: 80 }, true)
    })
    await act(async () => fixture.root.unmount())
    await act(async () => {
      probe.jsQueue.splice(0).forEach((fn) => fn())
    })
    expect(fixture.onReorder).not.toHaveBeenCalled()
  })
})

it('stops scrolling at the viewport edge when rows are replaced', async () => {
  const fixture = await mounted()
  probe.viewport = { pageY: 0, height: 100 }
  await act(async () => {
    fixture.gesture.start!({ absoluteY: 90, translationY: 0 }, true)
    probe.frame!({ timeSincePreviousFrame: 16 })
  })
  expect(probe.scroll).toHaveBeenCalledTimes(1)
  await fixture.updateItems(['b', 'c'])
  await act(async () => probe.frame!({ timeSincePreviousFrame: 16 }))
  expect(probe.scroll).toHaveBeenCalledTimes(1)
  expect(probe.frameActive).toHaveBeenLastCalledWith(false)
  await act(async () => fixture.root.unmount())
})

it('keeps measured rows still on hold, restores cancellation, and drops by moved ID plus neighbor', async () => {
  const move = vi.fn()
  function Harness() {
    return createElement(DragReorderList<string>, {
      items: ['a', 'b', 'c'],
      itemKey: (item) => item,
      rowPresentation: 'plain',
      renderRow: (item, handle) => createElement('Text', null, item, handle),
      onMove: move,
      scrollRef: useAnimatedRef<Animated.ScrollView>(),
      scrollOffsetY: useSharedValue(0),
      scrollContentHeight: useSharedValue(140)
    })
  }
  let root: ReturnType<typeof create>
  await act(async () => {
    root = create(createElement(Harness))
  })
  const handle = root!.root.findAllByType(Animated.View).find((node) => node.props.hitSlop)!
  const handleStyle = Object.assign({}, ...handle.props.style)
  const gripWidth = handle.findByType(GripVertical).props.size
  const width = gripWidth + 2 * handleStyle.paddingHorizontal
  const left = queuedMessageStyles.row.paddingLeft - handle.props.hitSlop.left
  const right = queuedMessageStyles.row.paddingLeft + width + handle.props.hitSlop.right
  expect(handleStyle.paddingHorizontal).toBe(spacing.xs)
  expect([left, right]).toEqual([4, 62])
  expect(right - Math.max(0, left)).toBe(58)
  const rows = root!.root.findAll(
    (node) => node.type === Animated.View && typeof node.props.onLayout === 'function'
  )
  await act(async () =>
    rows.forEach((row, index) =>
      row.props.onLayout({ nativeEvent: { layout: { height: index === 0 ? 100 : 20 } } })
    )
  )
  await publishLayout()
  const gesture = probe.gestures.at(-3)!
  const at = (translationY: number) => ({ absoluteY: 100 + translationY, translationY })
  await act(async () => {
    gesture.start!(at(0), true)
    gesture.update!(at(0), true)
    gesture.finalize!(at(0), true)
    gesture.start!(at(0), true)
    gesture.update!(at(35), true)
    gesture.finalize!(at(35), false)
  })
  expect(move).not.toHaveBeenCalled()
  await act(async () => {
    gesture.start!(at(0), true)
    gesture.update!(at(35), true)
    gesture.finalize!(at(35), true)
  })
  expect(move).toHaveBeenCalledExactlyOnceWith({ movedId: 'a', afterId: 'c' })
  await act(async () => root!.unmount())
})
