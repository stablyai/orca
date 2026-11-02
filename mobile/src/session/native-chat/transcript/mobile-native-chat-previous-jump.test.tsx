import { createElement as h, useRef, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import type { MobileNativeChatScrollNode } from '../../mobile-native-chat-reading-place'
import { MobileNativeChatRowList } from './MobileNativeChatRowList'
import type { MobileNativeChatRowKeys } from './mobile-native-chat-row-keys'
import type {
  MobileNativeChatListHandle,
  MobileNativeChatTailFollow
} from './use-mobile-native-chat-tail-follow'

const platform = vi.hoisted(() => ({ OS: 'web' }))
const scrollerSlot = vi.hoisted(() => ({ current: null as ScrollNode | null }))
const nativeApi = vi.hoisted(() => ({
  offsets: [] as { offset: number; animated: boolean }[],
  drags: 0
}))

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    Platform: platform,
    View: 'View',
    Text: 'Text',
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    ScrollView: React.forwardRef(
      (props: { children?: React.ReactNode; onScroll?: (event: unknown) => void }, ref) => {
        React.useImperativeHandle(ref, () => ({
          getScrollableNode: () => scrollerSlot.current,
          getInnerViewNode: () => scrollerSlot.current
        }))
        return React.createElement('ScrollView', props, props.children)
      }
    ),
    FlatList: React.forwardRef(
      (
        props: {
          data?: NativeChatMessage[]
          keyExtractor?: (item: NativeChatMessage) => string
          renderItem?: (row: { item: NativeChatMessage; index: number }) => React.ReactNode
          CellRendererComponent?: (props: {
            item: NativeChatMessage
            index: number
            cellKey: string
          }) => React.ReactElement
          onScroll?: (event: unknown) => void
          onScrollBeginDrag?: () => void
          onMomentumScrollEnd?: (event: unknown) => void
        },
        ref
      ) => {
        const latest = React.useRef(props)
        latest.current = props
        React.useImperativeHandle(ref, () => ({
          scrollToEnd: () => {},
          scrollToOffset: (params: { offset: number; animated?: boolean }) => {
            const animated = params.animated !== false
            nativeApi.offsets.push({ offset: params.offset, animated })
            const current = latest.current
            if (!animated) {
              const event = scrollEvent(params.offset)
              current.onScroll?.(event)
              current.onMomentumScrollEnd?.(event)
            }
            nativeApi.drags += 1
            current.onScrollBeginDrag?.()
          },
          scrollToIndex: () => {
            nativeApi.drags += 1
            latest.current.onScrollBeginDrag?.()
          }
        }))
        const Cell = props.CellRendererComponent
        const data = props.data ?? []
        return React.createElement(
          'FlatList',
          props,
          Cell
            ? data.map((item, index) =>
                React.createElement(
                  Cell,
                  {
                    key: props.keyExtractor?.(item) ?? String(index),
                    item,
                    index,
                    cellKey: String(index)
                  },
                  props.renderItem?.({ item, index }) ?? null
                )
              )
            : null
        )
      }
    )
  }
})

type ScrollNode = MobileNativeChatScrollNode & {
  addEventListener: () => void
  removeEventListener: () => void
  writes: number[]
}

const SPAN = 1_000

function pageScroller(): ScrollNode {
  const docs = [
    { id: 'm0', doc: 0 },
    { id: 'm1', doc: 500 },
    { id: 'm2', doc: 1_000 }
  ]
  const node = {
    scrollHeight: 1_400,
    clientHeight: 400,
    writes: [] as number[],
    top: 0,
    get scrollTop(): number {
      return this.top
    },
    set scrollTop(value: number) {
      this.top = value
      this.writes.push(value)
    },
    getBoundingClientRect: () => ({ top: 0, bottom: 400 }),
    getAttribute: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: (selector: string) => {
      if (!selector.includes('data-chat-rows')) {
        return null
      }
      return {
        children: docs.map((row) => ({
          getAttribute: (name: string) => (name === 'data-testid' ? `chat-row:${row.id}` : null),
          getBoundingClientRect: () => {
            const top = row.doc - SPAN - node.scrollTop
            return { top, bottom: top + 200 }
          },
          querySelectorAll: () => [],
          nextElementSibling: null,
          children: []
        })),
        nextElementSibling: null
      }
    }
  }
  return node as ScrollNode
}

function scrollEvent(y: number) {
  return {
    nativeEvent: {
      contentOffset: { x: 0, y },
      contentSize: { width: 400, height: 1_400 },
      layoutMeasurement: { width: 400, height: 400 }
    }
  }
}

const messages: NativeChatMessage[] = ['m0', 'm1', 'm2'].map((id) => ({
  id,
  role: 'user',
  timestamp: null,
  source: 'transcript',
  blocks: [{ type: 'text', text: id }]
}))

const rowKeys = {
  scope: 'chat',
  sourceHead: undefined,
  keyOf: (message: NativeChatMessage) => message.id,
  current: (key: string) => key,
  placement: (key: string) => key
} as MobileNativeChatRowKeys

function tailOf(
  listRef: (list: MobileNativeChatListHandle | null) => void,
  onEndDistance: (fromEnd: number, byReader: boolean) => void = () => {},
  beginUserScroll: () => void = () => {},
  endMomentum: () => void = () => {}
): MobileNativeChatTailFollow {
  return {
    listProps: { ref: listRef },
    pageListProps: { ref: listRef, isFollowing: () => false, onEndDistance },
    showJumpToTail: false,
    showPreviousMessage: true,
    previousStopsRef: { current: ['m0', 'm1', 'm2'] },
    jumpToPreviousMessage: () => {},
    refreshPreviousMessage: () => {},
    pinToTail: () => {},
    pinToTailAfterContentResize: () => {},
    jumpToTail: () => {},
    beginUserScroll,
    endUserDrag: () => {},
    beginMomentum: () => {},
    endMomentum,
    scrollMayLoadEarlier: () => false,
    recordScrollMetrics: () => {}
  }
}

const queued: { frames: Map<number, FrameRequestCallback> } = { frames: new Map() }

function runLatestFrame(): void {
  const id = Math.max(...queued.frames.keys())
  const frame = queued.frames.get(id)
  if (!frame) {
    throw new Error('no animation frame')
  }
  queued.frames.delete(id)
  act(() => frame(performance.now() + 280))
}

function Host(props: {
  listRef: (list: MobileNativeChatListHandle | null) => void
  onEndDistance?: (fromEnd: number, byReader: boolean) => void
  beginUserScroll?: () => void
}): ReactElement {
  const onEnd = useRef(props.onEndDistance ?? (() => {}))
  onEnd.current = props.onEndDistance ?? (() => {})
  const began = useRef(props.beginUserScroll ?? (() => {}))
  began.current = props.beginUserScroll ?? (() => {})
  return h(MobileNativeChatRowList, {
    tail: tailOf(
      props.listRef,
      (fromEnd, byReader) => onEnd.current(fromEnd, byReader),
      () => began.current()
    ),
    rowKeys,
    rows: messages,
    renderItem: () => h('Row'),
    layoutKey: 'layout',
    contentContainerStyle: null,
    header: null,
    footer: null,
    emptyStateView: null,
    onScroll: () => {},
    hasHeader: false
  })
}

describe('previous-message jump while the list is moving', () => {
  let renderer: ReactTestRenderer | undefined

  function hostNodes(type: string) {
    return renderer?.root.findAll((item) => item.type === type) ?? []
  }

  function hostNode(type: string) {
    const node = hostNodes(type)[0]
    if (!node) {
      throw new Error(`${type} missing`)
    }
    return node
  }

  beforeEach(() => {
    nativeApi.offsets.length = 0
    nativeApi.drags = 0
    queued.frames = new Map()
    let next = 1
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = next++
      queued.frames.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      queued.frames.delete(id)
    })
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    )
    platform.OS = 'web'
    scrollerSlot.current = pageScroller()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = undefined
    vi.unstubAllGlobals()
  })

  function mount(
    onEndDistance?: (fromEnd: number, byReader: boolean) => void,
    beginUserScroll?: () => void
  ): MobileNativeChatListHandle {
    let list: MobileNativeChatListHandle | null = null
    act(() => {
      renderer = create(
        h(Host, {
          listRef: (next) => {
            list = next
          },
          onEndDistance,
          beginUserScroll
        })
      )
    })
    if (!list) {
      throw new Error('list handle missing')
    }
    return list
  }

  it('stops a moving web list, then chains one message per tap from the committed target', () => {
    const list = mount()
    const scroller = scrollerSlot.current
    if (!scroller) {
      throw new Error('scroller missing')
    }
    act(() => list.revealPreviousMessage?.(['m0', 'm1', 'm2'], true))
    expect(scroller.writes.slice(0, 2)).toEqual([-1, 0])
    expect(queued.frames.size).toBe(1)
    act(() => list.revealPreviousMessage?.(['m0', 'm1', 'm2'], true))
    expect(queued.frames.size).toBe(1)
    runLatestFrame()
    expect(scroller.scrollTop).toBe(-1_000)
  })

  it('does not treat the web jump’s own scroll events as the reader', () => {
    const readers: boolean[] = []
    const list = mount((_fromEnd, byReader) => readers.push(byReader))
    const scroller = scrollerSlot.current
    if (!scroller) {
      throw new Error('scroller missing')
    }
    act(() => list.revealPreviousMessage?.(['m0', 'm1', 'm2'], true))
    scroller.scrollTop = -40
    act(() => {
      hostNode('ScrollView').props.onScroll({})
    })
    expect(readers).toEqual([false])
    expect(queued.frames.size).toBe(1)
    runLatestFrame()
    expect(scroller.scrollTop).toBe(-500)
  })

  it('stops a native fling, then steps once per tap without using the mid-jump offset', () => {
    platform.OS = 'ios'
    const began: string[] = []
    const list = mount(undefined, () => began.push('drag'))
    const views = hostNodes('View')
    act(() => {
      views.forEach((view, index) => {
        view.props.onLayout?.({
          nativeEvent: { layout: { x: 0, y: index * 500, width: 400, height: 400 } }
        })
      })
      hostNode('FlatList').props.onScroll(scrollEvent(1_000))
    })
    act(() => list.revealPreviousMessage?.(['m0', 'm1', 'm2'], true))
    expect(nativeApi.offsets).toEqual([
      { offset: 1_000, animated: false },
      { offset: 500, animated: true }
    ])
    expect(began).toEqual([])
    act(() => {
      hostNode('FlatList').props.onMomentumScrollEnd(scrollEvent(900))
    })
    act(() => list.revealPreviousMessage?.(['m0', 'm1', 'm2'], true))
    expect(nativeApi.offsets.at(-2)).toEqual({ offset: 900, animated: false })
    expect(nativeApi.offsets.at(-1)).toEqual({ offset: 0, animated: true })
  })

  it('measures the settled native offset after the jump lands', () => {
    platform.OS = 'ios'
    const list = mount()
    const views = hostNodes('View')
    act(() => {
      views.forEach((view, index) => {
        view.props.onLayout?.({
          nativeEvent: { layout: { x: 0, y: index * 500, width: 400, height: 400 } }
        })
      })
      hostNode('FlatList').props.onScroll(scrollEvent(1_000))
    })
    act(() => list.revealPreviousMessage?.(['m0', 'm1', 'm2'], true))
    const listNode = hostNode('FlatList')
    act(() => {
      listNode?.props.onScroll(scrollEvent(500))
      listNode?.props.onMomentumScrollEnd(scrollEvent(500))
    })
    act(() => listNode?.props.onScroll(scrollEvent(700)))
    act(() => list.revealPreviousMessage?.(['m0', 'm1', 'm2'], true))
    expect(nativeApi.offsets.at(-2)).toEqual({ offset: 700, animated: false })
    expect(nativeApi.offsets.at(-1)).toEqual({ offset: 500, animated: true })
  })

  it('drops the native chain when a finger takes the list', () => {
    platform.OS = 'ios'
    const began: string[] = []
    const list = mount(undefined, () => began.push('drag'))
    const views = hostNodes('View')
    act(() => {
      views.forEach((view, index) => {
        view.props.onLayout?.({
          nativeEvent: { layout: { x: 0, y: index * 500, width: 400, height: 400 } }
        })
      })
      hostNode('FlatList').props.onScroll(scrollEvent(1_000))
    })
    act(() => list.revealPreviousMessage?.(['m0', 'm1', 'm2'], true))
    act(() => hostNode('FlatList').props.onScrollBeginDrag())
    expect(began).toEqual(['drag'])
    act(() => list.revealPreviousMessage?.(['m0', 'm1', 'm2'], true))
    expect(nativeApi.offsets.at(-1)).toEqual({ offset: 500, animated: true })
  })
})
