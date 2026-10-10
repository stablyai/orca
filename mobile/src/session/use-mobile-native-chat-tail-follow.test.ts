import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useMobileNativeChatTailFollow,
  type MobileNativeChatTailFollow
} from './use-mobile-native-chat-tail-follow'

const scrollToEnd = vi.fn()
const scrollToOffset = vi.fn()

let renderer: ReactTestRenderer | null = null
let tail: MobileNativeChatTailFollow<string> | null = null

// Wired the way MobileNativeChatView wires its transcript list.
function Transcript(): ReturnType<typeof createElement> {
  const follow = useMobileNativeChatTailFollow<string>({ hasItems: true })
  tail = follow
  return createElement('FlatList', {
    ref: follow.listRef,
    onScroll: (event: { nativeEvent: Parameters<typeof follow.recordScrollMetrics>[0] }) =>
      follow.recordScrollMetrics(event.nativeEvent),
    onScrollBeginDrag: follow.beginUserScroll,
    onScrollEndDrag: follow.endUserDrag,
    onMomentumScrollBegin: follow.beginMomentum,
    onMomentumScrollEnd: follow.endMomentum,
    onContentSizeChange: follow.pinToTailAfterContentResize
  })
}

// Host element names are plain strings at runtime; React Native's types don't list them.
function hostNamed(name: string): ReactTestInstance {
  return renderer!.root.find((node) => node.type === name)
}

function list(): ReactTestInstance {
  return hostNamed('FlatList')
}

/** A scroll event in a 500pt viewport; 80pt from the bottom still counts as the tail. */
function at(offsetY: number, contentHeight = 1_200) {
  return {
    nativeEvent: {
      contentOffset: { y: offsetY },
      contentSize: { height: contentHeight },
      layoutMeasurement: { height: 500 }
    }
  }
}

describe('useMobileNativeChatTailFollow gesture settling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0)
    )
    vi.stubGlobal('cancelAnimationFrame', (handle: ReturnType<typeof setTimeout>) =>
      clearTimeout(handle)
    )
    act(() => {
      renderer = create(createElement(Transcript), {
        createNodeMock: () => ({ scrollToEnd, scrollToOffset })
      })
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    tail = null
    scrollToEnd.mockReset()
    scrollToOffset.mockReset()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  // iOS emits a bare momentum-end after a non-animated pin; Android a begin/end pair after an animated one.
  it.each([
    ['momentum-end', false],
    ['momentum-begin/end pair', true]
  ])('ignores a programmatic %s while the finger is still down', (_label, withBegin) => {
    act(() => {
      list().props.onScrollBeginDrag({})
      if (withBegin) {
        list().props.onMomentumScrollBegin({})
      }
      list().props.onMomentumScrollEnd(at(700))
      list().props.onContentSizeChange(320, 1_250)
    })

    expect(scrollToEnd).not.toHaveBeenCalled()
    expect(scrollToOffset).not.toHaveBeenCalled()
  })

  it('settles a released drag from release metrics, not a programmatic momentum-end', () => {
    act(() => {
      list().props.onScrollBeginDrag({})
      list().props.onScrollEndDrag(at(200))
      list().props.onMomentumScrollEnd(at(700))
    })
    act(() => {
      vi.runOnlyPendingTimers()
    })
    act(() => list().props.onContentSizeChange(320, 1_250))

    expect(scrollToEnd).not.toHaveBeenCalled()
    expect(scrollToOffset).not.toHaveBeenCalled()
    expect(tail!.showJumpToTail).toBe(true)
  })

  it('uses momentum-end metrics instead of a stale throttled scroll sample', () => {
    act(() => {
      list().props.onScrollBeginDrag({})
      list().props.onScroll(at(700))
      list().props.onScrollEndDrag(at(700))
      list().props.onMomentumScrollBegin({})
      list().props.onMomentumScrollEnd(at(200, 1_300))
      list().props.onContentSizeChange(320, 1_350)
    })

    expect(scrollToEnd).not.toHaveBeenCalled()
    expect(scrollToOffset).not.toHaveBeenCalled()
    expect(tail!.showJumpToTail).toBe(true)
  })

  it('uses finger-release metrics when no momentum event follows', () => {
    act(() => {
      list().props.onScrollBeginDrag({})
      list().props.onScroll(at(200))
      list().props.onScrollEndDrag(at(620))
    })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    act(() => list().props.onContentSizeChange(320, 1_250))

    expect(scrollToEnd).toHaveBeenCalledOnce()
    expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1_250 })
  })

  it('repins when content grows between tail release and drag settle', () => {
    act(() => {
      list().props.onScrollBeginDrag({})
      list().props.onScrollEndDrag(at(700))
      list().props.onContentSizeChange(320, 1_250)
    })

    expect(scrollToEnd).not.toHaveBeenCalled()
    expect(scrollToOffset).not.toHaveBeenCalled()

    act(() => {
      vi.runOnlyPendingTimers()
    })

    expect(scrollToEnd).toHaveBeenCalledOnce()
    expect(scrollToEnd).toHaveBeenLastCalledWith({ animated: false })
    expect(tail!.showJumpToTail).toBe(false)
  })
})
