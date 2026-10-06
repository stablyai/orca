import { createElement } from 'react'
import { FlatList } from 'react-native'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  useMobileNativeChatTailFollow,
  type MobileNativeChatTailFollow
} from './use-mobile-native-chat-tail-follow'

const scrollToEnd = vi.hoisted(() => vi.fn())
const scrollToOffset = vi.hoisted(() => vi.fn())

// FlatList stand-in, matching MobileNativeChatView.test.ts: the imperative handle records which
// scroll verb the hook reaches for, which is the seam this suite pins.
vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    FlatList: React.forwardRef((props, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollToEnd, scrollToOffset }), [])
      return React.createElement('FlatList', props)
    })
  }
})

type Row = { id: string }

/** The host tag the FlatList stand-in renders; typed `string` so the narrowed union compares. */
const FLAT_LIST_TAG: string = 'FlatList'

const emptyRows: Row[] = []

let tail: MobileNativeChatTailFollow<Row> | null = null

/** Mirrors the view's wiring: the list ref, and `onContentSizeChange` → the resize pin. */
function Harness({ hasItems }: { hasItems: boolean }): ReturnType<typeof createElement> {
  tail = useMobileNativeChatTailFollow<Row>({ hasItems })
  // A variable, not an inline literal: `createElement` types `ref` out of the literal's props.
  const listProps = {
    data: emptyRows,
    renderItem: () => null,
    ref: tail.listRef,
    onContentSizeChange: tail.pinToTailAfterContentResize
  }
  return createElement(FlatList, listProps)
}

function hook(): MobileNativeChatTailFollow<Row> {
  if (tail === null) {
    throw new Error('the harness has not rendered')
  }
  return tail
}

function list(renderer: ReactTestRenderer | null): ReactTestInstance {
  if (renderer === null) {
    throw new Error('the harness has not rendered')
  }
  return renderer.root.find((node) => typeof node.type === 'string' && node.type === FLAT_LIST_TAG)
}

describe('useMobileNativeChatTailFollow', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    tail = null
    scrollToEnd.mockReset()
    scrollToOffset.mockReset()
  })

  function render(hasItems = true): void {
    act(() => {
      renderer = create(createElement(Harness, { hasItems }))
    })
  }

  function contentResized(width: number, height: number): void {
    act(() => list(renderer).props.onContentSizeChange(width, height))
  }

  function rerender(hasItems: boolean): void {
    act(() => {
      renderer?.update(createElement(Harness, { hasItems }))
    })
  }

  it('pins to the measured content height while following', () => {
    render()

    contentResized(320, 900)

    expect(scrollToOffset).toHaveBeenCalledOnce()
    expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 900 })
    expect(scrollToEnd).not.toHaveBeenCalled()
  })

  it('re-pins to the latest measured height without ever calling scrollToEnd', () => {
    render()
    contentResized(320, 900)
    contentResized(320, 1_300)

    // What `onLayout` triggers: the passive re-pin.
    act(() => hook().pinToTail())

    expect(scrollToOffset).toHaveBeenCalledTimes(3)
    expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1_300 })
    expect(scrollToEnd).not.toHaveBeenCalled()
  })

  it('scrolls on neither path once detached from the tail', () => {
    render()
    act(() => hook().detachFromTail())

    contentResized(320, 900)
    act(() => hook().pinToTail())

    expect(scrollToOffset).not.toHaveBeenCalled()
    expect(scrollToEnd).not.toHaveBeenCalled()
  })

  it('does not pin before any content height has been measured', () => {
    render()

    act(() => hook().pinToTail())

    expect(scrollToOffset).not.toHaveBeenCalled()
    expect(scrollToEnd).not.toHaveBeenCalled()
  })

  it('does not pin when the list has no items', () => {
    render(false)

    contentResized(320, 900)
    act(() => hook().pinToTail())

    expect(scrollToOffset).not.toHaveBeenCalled()
    expect(scrollToEnd).not.toHaveBeenCalled()
  })

  it('forgets a measured height once the list empties, so a later pin ignores it', () => {
    render(true)
    contentResized(320, 900)
    scrollToOffset.mockReset()

    // The list empties and comes back: the height measured for the old transcript must not pin.
    rerender(false)
    rerender(true)
    act(() => hook().pinToTail())

    expect(scrollToOffset).not.toHaveBeenCalled()
  })
})
