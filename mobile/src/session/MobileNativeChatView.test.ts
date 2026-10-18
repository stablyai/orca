import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatView } from './MobileNativeChatView'

const scrollToEnd = vi.hoisted(() => vi.fn())
const scrollToOffset = vi.hoisted(() => vi.fn())
const platform = vi.hoisted(() => ({ OS: 'ios' }))
// The page list's live DOM geometry.
const pageScroller = vi.hoisted(() => {
  const listeners = new Map<string, Set<(event?: unknown) => void>>()
  return {
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 500,
    clientWidth: 320,
    style: { overflowAnchor: '' },
    getInnerViewNode: () => ({}),
    getBoundingClientRect: () => ({ top: 0, bottom: 500 }),
    addEventListener: (type: string, listener: (event?: unknown) => void) => {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener))
    },
    removeEventListener: (type: string, listener: (event?: unknown) => void) => {
      listeners.get(type)?.delete(listener)
    },
    // The browser's scroll event at the scroller's current position.
    scroll: () => listeners.get('scroll')?.forEach((listener) => listener()),
    // The reader's hand on the scroller, e.g. a wheel turn.
    input: (type: string) => listeners.get(type)?.forEach((listener) => listener())
  }
})
const getScrollableNode = vi.hoisted(() => () => pageScroller)

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    FlatList: React.forwardRef((props, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollToEnd, scrollToOffset, getScrollableNode }), [])
      return React.createElement('FlatList', props)
    }),
    Platform: platform,
    Pressable: 'Pressable',
    ScrollView: React.forwardRef((props, ref) => {
      React.useImperativeHandle(
        ref,
        () => ({
          scrollTo: ({ y, animated }: { y: number; animated: boolean }) =>
            scrollToOffset({ animated, offset: y }),
          scrollToEnd,
          getScrollableNode
        }),
        []
      )
      return React.createElement('ScrollView', props)
    }),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: 'Text',
    View: 'View'
  }
})

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))

vi.mock('react-native-gesture-handler', () => {
  const chain = {
    runOnJS: () => chain,
    onStart: () => chain,
    onUpdate: () => chain
  }
  return {
    Gesture: { Simultaneous: () => ({}), Native: () => ({}), Pinch: () => chain },
    GestureDetector: 'GestureDetector',
    GestureHandlerRootView: 'GestureHandlerRootView'
  }
})

vi.mock('lucide-react-native', () => ({
  ArrowDown: 'ArrowDown',
  ChevronsDownUp: 'ChevronsDownUp',
  ChevronsUpDown: 'ChevronsUpDown',
  Square: 'Square'
}))

vi.mock('./MobileNativeChatMessage', () => ({ MobileNativeChatMessage: 'ChatMessage' }))
vi.mock('./MobileNativeChatLiveLine', () => ({ MobileNativeChatLiveLine: 'LiveStatus' }))
vi.mock('./MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./MobileNativeChatPermission', () => ({ MobileNativeChatPermission: 'ChatPermission' }))
vi.mock('./MobileNativeChatQuestion', () => ({ MobileNativeChatQuestion: 'ChatQuestion' }))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('./MobileAgentWorkingIndicator', () => ({
  MobileAgentWorkingIndicator: 'WorkingIndicator'
}))

// Stand-in composer: exposes the view's `handleSend` through a pressable, which is
// the only composer behaviour these banner tests exercise.
vi.mock('./MobileNativeChatComposer', async () => {
  const React = await import('react')
  return {
    MobileNativeChatComposer: (props: {
      onSend: (text: string) => Promise<boolean>
      disabled?: boolean
      placeholder?: string
    }) =>
      React.createElement('Composer', {
        ...props,
        accessibilityLabel: 'Send message',
        onPress: () => props.onSend('hi')
      })
  }
})

type Overrides = {
  messages?: Parameters<typeof MobileNativeChatView>[0]['messages']
  folded?: Parameters<typeof MobileNativeChatView>[0]['folded']
  streaming?: string | null
  sendErrorMessage?: string | null
  onClearSendError?: () => void
  inputLockReason?: 'disconnected' | 'waiting' | null
  onSend?: (text: string) => Promise<boolean>
  pending?: Parameters<typeof MobileNativeChatView>[0]['pending']
  structuredActivityUi?: boolean
  turnIndicator?: Parameters<typeof MobileNativeChatView>[0]['turnIndicator']
  agentWorking?: boolean
  canStop?: boolean
  ask?: Parameters<typeof MobileNativeChatView>[0]['ask']
  question?: Parameters<typeof MobileNativeChatView>[0]['question']
  permission?: Parameters<typeof MobileNativeChatView>[0]['permission']
  sendSurfaceId?: string
  keyboardInset?: number
  hasMore?: boolean
  onLoadEarlier?: () => void
  status?: Parameters<typeof MobileNativeChatView>[0]['status']
  error?: string
  readFailedFinally?: boolean
}

function assistantTurn(id: string, text: string): NativeChatMessage {
  return { id, role: 'assistant', blocks: [{ type: 'text', text }], timestamp: 0, source: 'hook' }
}

function chatViewElement(overrides: Overrides): ReturnType<typeof createElement> {
  return createElement(MobileNativeChatView, {
    messages: [],
    folded: [],
    status: 'ready',
    streaming: null,
    onSend: vi.fn().mockResolvedValue(true),
    sendSurfaceId: 'tab-a',
    getSendCompletionGeneration: () => 0,
    pending: [],
    composerText: '',
    onComposerTextChange: vi.fn(),
    ...overrides
  })
}

describe('MobileNativeChatView', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0)
    )
    vi.stubGlobal('cancelAnimationFrame', (handle: ReturnType<typeof setTimeout>) =>
      clearTimeout(handle)
    )
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    scrollToEnd.mockReset()
    scrollToOffset.mockReset()
    vi.unstubAllGlobals()
  })

  async function render(overrides: Overrides = {}): Promise<void> {
    await act(async () => {
      renderer = create(chatViewElement(overrides))
    })
  }

  async function update(overrides: Overrides = {}): Promise<void> {
    await act(async () => {
      renderer?.update(chatViewElement(overrides))
    })
  }

  it("holds Stop and says Stopping while this phone's own Stop request is in flight", async () => {
    await render({
      structuredActivityUi: true,
      agentWorking: true,
      canStop: true,
      turnIndicator: {
        thinking: false,
        activityText: null,
        stopping: true,
        stopRequestInFlight: true
      }
    })
    const stop = renderer!.root.find(
      (node) => node.type === 'Pressable' && node.props.accessibilityLabel === 'Stopping…'
    )
    expect(stop.props.disabled).toBe(true)
  })

  it.each([
    ['queue', 'Queue a message to run after the stop'],
    ['send', 'Send a message to run after the stop']
  ] as const)(
    'tells the composer a message sent now runs after the stop (%s)',
    async (afterStop, placeholder) => {
      await render({
        structuredActivityUi: true,
        agentWorking: true,
        canStop: true,
        turnIndicator: { thinking: false, activityText: null, stopping: true, afterStop }
      })
      const composer = renderer!.root.find((node) => node.type === 'Composer')
      expect(composer.props.placeholder).toBe(placeholder)
    }
  )

  // A Stop the provider took and never answered ends only at a repeat Stop.
  it('keeps Stop for the repeat that escalates while the host alone says Stopping', async () => {
    await render({
      structuredActivityUi: true,
      agentWorking: true,
      canStop: true,
      turnIndicator: { thinking: false, activityText: null, stopping: true }
    })
    const stop = renderer!.root.find(
      (node) => node.type === 'Pressable' && node.props.accessibilityLabel === 'Stop the agent'
    )
    expect(stop.props.disabled).toBe(false)
  })

  /** Ids of the rows the list is currently rendering. */
  it('keeps Stop hidden during a structured dispatch until a provider turn can be cancelled', async () => {
    const props = { structuredActivityUi: true, agentWorking: true, canStop: false }
    await render(props)
    const stops = () =>
      renderer!.root.findAll((node) => node.props.accessibilityLabel === 'Stop the agent')
    expect(stops()).toHaveLength(0)
    await update({ ...props, canStop: true })
    expect(stops()).toHaveLength(1)
    await update({ agentWorking: true })
    expect(stops()).toHaveLength(1)
  })

  function listIds(): string[] {
    return (list().props.data as { id: string }[]).map((row) => row.id)
  }

  function list(): ReactTestInstance {
    return renderer!.root.find((node) => node.type === 'FlatList')
  }

  /** What the list reports from a scroll, drag or momentum event, in a 500-tall viewport. */
  function scrollEvent(y: number, contentHeight: number) {
    return {
      nativeEvent: {
        contentOffset: { y },
        contentSize: { height: contentHeight },
        layoutMeasurement: { height: 500 }
      }
    }
  }

  function renderedRow(id: string): ReturnType<typeof createElement> {
    const listNode = list()
    const data = listNode.props.data as NativeChatMessage[]
    const index = data.findIndex((row) => row.id === id)
    return listNode.props.renderItem({ item: data[index], index })
  }

  function banners(): ReactTestInstance[] {
    return renderer!.root.findAll((node) => node.props.accessibilityRole === 'alert')
  }

  function composer(): ReactTestInstance {
    return renderer!.root.find((node) => node.type === 'Composer')
  }

  function bannerText(): string {
    const [alert, ...rest] = banners()
    expect(rest).toHaveLength(0)
    return alert
      .findAll((node) => node.type === 'Text')
      .map((node) => node.props.children)
      .join('')
  }

  async function pressSend(): Promise<void> {
    const composer = renderer!.root.find((node) => node.type === 'Composer') as {
      props: { onPress: () => Promise<boolean> }
    }
    await act(async () => {
      await composer.props.onPress()
    })
  }

  async function scrollAwayFromTail(): Promise<void> {
    await act(async () => {
      list().props.onScrollBeginDrag?.({})
      list().props.onScroll(scrollEvent(200, 1_200))
    })
  }

  // A read no retry gets past takes the whole pane, even over a transcript already on screen: its
  // words alone, and nothing that could only be refused again.
  it('leaves only the words of a read that failed for good, over a loaded transcript', async () => {
    const loaded = [assistantTurn('m1', 'earlier reply')]
    const words = 'This chat was saved by a newer Orca. Update Orca to open it.'
    const shown = (text: string) =>
      renderer!.root.findAll((node) => node.type === 'Text' && node.props.children === text)
    const composers = () => renderer!.root.findAll((node) => node.type === 'Composer')
    const lists = () => renderer!.root.findAll((node) => node.type === 'FlatList')
    const failure = {
      messages: loaded,
      folded: loaded,
      status: 'error' as const,
      error: words,
      canStop: true,
      permission: { title: 'Approve?', options: [{ label: 'Allow', send: '1' }] },
      // A resend answered unknown says nothing beside the read's words.
      sendErrorMessage: 'Message unconfirmed — check chat before retrying'
    }
    await render({ ...failure, readFailedFinally: true })
    expect(shown(words)).toHaveLength(1)
    expect(composers()).toHaveLength(0)
    expect(lists()).toHaveLength(0)
    expect(banners()).toHaveLength(0)
    expect(renderer!.root.findAllByProps({ accessibilityLabel: 'Stop the agent' })).toHaveLength(0)

    // A failure that can clear keeps the transcript and the composer.
    await update({ ...failure, error: "Orca couldn't open this chat's history right now." })
    expect(listIds()).toEqual(['m1'])
    expect(composers()).toHaveLength(1)
    expect(banners()).toHaveLength(1)
  })

  it('renders the route-reported failure verbatim', async () => {
    await render({ sendErrorMessage: 'Permission reply failed' })

    expect(banners()).toHaveLength(1)
    expect(bannerText()).toContain('Permission reply failed')
  })

  it('does not duplicate the route banner when the composer rejects', async () => {
    const onClearSendError = vi.fn()
    await render({
      onSend: vi.fn().mockResolvedValue(false),
      inputLockReason: 'disconnected',
      sendErrorMessage: 'Stop failed',
      onClearSendError
    })
    await pressSend()

    expect(onClearSendError).not.toHaveBeenCalled()
    expect(banners()).toHaveLength(1)
    expect(bannerText()).toContain('Stop failed')
    expect(bannerText()).toBe('Stop failed')
  })

  it('retires the route-owned banner once a send is accepted', async () => {
    const onClearSendError = vi.fn()
    await render({ sendErrorMessage: 'Stop failed', onClearSendError })

    await pressSend()

    expect(onClearSendError).toHaveBeenCalledOnce()
  })

  // The gate that decides `streaming` lives in MobileNativeChatOverlay, which
  // outlives this view; see MobileNativeChatOverlay.test.ts.
  it('appends the gated streaming bubble after the folded transcript', async () => {
    const folded = [assistantTurn('a1', 'The tests pass.')]
    await render({ folded })
    expect(listIds()).toEqual(['a1'])

    await update({ folded, streaming: 'The tests' })

    expect(listIds()).toEqual(['a1', 'streaming'])
  })

  it('lets content growth own streaming tail-follow without a delayed animated command', async () => {
    vi.useFakeTimers()
    try {
      const folded = [assistantTurn('a1', 'Starting')]
      await render({ folded })
      await act(async () => {
        vi.runOnlyPendingTimers()
      })
      scrollToEnd.mockClear()

      await update({ folded, streaming: 'Streaming output' })
      act(() => list().props.onContentSizeChange(320, 900))

      expect(scrollToOffset).toHaveBeenCalledOnce()
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 900 })
      await act(async () => {
        vi.advanceTimersByTime(60)
      })
      expect(scrollToOffset).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops tail-follow before loading earlier history can resize the list', async () => {
    const folded = [assistantTurn('a1', 'History')]
    const onLoadEarlier = vi.fn()
    await render({ folded, hasMore: true, onLoadEarlier })
    scrollToEnd.mockClear()

    act(() => {
      list().props.onScrollBeginDrag?.({})
      list().props.onScroll(scrollEvent(40, 1_200))
      list().props.onContentSizeChange(320, 950)
    })

    expect(onLoadEarlier).toHaveBeenCalledOnce()
    expect(scrollToEnd).not.toHaveBeenCalled()
    expect(scrollToOffset).not.toHaveBeenCalled()
  })

  it('does not treat programmatic scroll metrics as user intent', async () => {
    const folded = [assistantTurn('a1', 'Latest')]
    await render({ folded })
    scrollToEnd.mockClear()

    act(() => {
      list().props.onScroll(scrollEvent(200, 1_200))
      list().props.onContentSizeChange(320, 1_300)
    })

    expect(scrollToOffset).toHaveBeenCalledOnce()
    expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1_300 })
    expect(
      renderer!.root.findAll((node) => node.props.accessibilityLabel === 'Scroll to latest')
    ).toHaveLength(0)
  })

  it('keeps tail-follow paused across the drag-to-momentum handoff', async () => {
    vi.useFakeTimers()
    try {
      const folded = [assistantTurn('a1', 'Latest')]
      await render({ folded })
      scrollToEnd.mockClear()

      act(() => list().props.onScrollBeginDrag?.({}))
      expect(
        renderer!.root.findAll((node) => node.props.accessibilityLabel === 'Scroll to latest')
      ).toHaveLength(0)

      act(() => {
        list().props.onScroll(scrollEvent(700, 1_200))
        list().props.onScrollEndDrag?.(scrollEvent(700, 1_200))
        list().props.onContentSizeChange(320, 1_250)
        list().props.onMomentumScrollBegin?.({})
      })
      await act(async () => {
        vi.advanceTimersByTime(200)
      })
      act(() => list().props.onContentSizeChange(320, 1_300))

      expect(scrollToEnd).not.toHaveBeenCalled()
      expect(scrollToOffset).not.toHaveBeenCalled()

      act(() => {
        list().props.onMomentumScrollEnd?.(scrollEvent(800, 1_300))
        list().props.onContentSizeChange(320, 1_350)
      })
      expect(scrollToEnd).toHaveBeenCalledOnce()
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1_350 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses momentum-end metrics instead of a stale throttled scroll sample', async () => {
    const folded = [assistantTurn('a1', 'Latest')]
    await render({ folded })
    scrollToEnd.mockClear()

    act(() => {
      list().props.onScrollBeginDrag?.({})
      list().props.onScroll(scrollEvent(700, 1_200))
      list().props.onScrollEndDrag?.(scrollEvent(700, 1_200))
      list().props.onMomentumScrollBegin?.({})
      list().props.onMomentumScrollEnd?.(scrollEvent(200, 1_300))
      list().props.onContentSizeChange(320, 1_350)
    })

    expect(scrollToEnd).not.toHaveBeenCalled()
    expect(scrollToOffset).not.toHaveBeenCalled()
    expect(
      renderer!.root.findAll((node) => node.props.accessibilityLabel === 'Scroll to latest')
    ).toHaveLength(1)
  })

  it('uses finger-release metrics when no momentum event follows', async () => {
    vi.useFakeTimers()
    try {
      const folded = [assistantTurn('a1', 'Latest')]
      await render({ folded })
      scrollToEnd.mockClear()

      act(() => {
        list().props.onScrollBeginDrag?.({})
        list().props.onScroll(scrollEvent(200, 1_200))
        list().props.onScrollEndDrag?.(scrollEvent(620, 1_200))
      })
      await act(async () => {
        vi.advanceTimersByTime(200)
      })
      act(() => list().props.onContentSizeChange(320, 1_250))

      expect(scrollToEnd).toHaveBeenCalledOnce()
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1_250 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('repins when content grows between tail release and drag settle', async () => {
    vi.useFakeTimers()
    try {
      const folded = [assistantTurn('a1', 'Latest')]
      await render({ folded })
      scrollToEnd.mockClear()

      act(() => {
        list().props.onScrollBeginDrag?.({})
        list().props.onScrollEndDrag?.(scrollEvent(700, 1_200))
        list().props.onContentSizeChange(320, 1_250)
      })

      expect(scrollToEnd).not.toHaveBeenCalled()
      expect(scrollToOffset).not.toHaveBeenCalled()

      await act(async () => {
        vi.runOnlyPendingTimers()
      })

      expect(scrollToEnd).toHaveBeenCalledOnce()
      expect(scrollToEnd).toHaveBeenLastCalledWith({ animated: false })
      expect(
        renderer!.root.findAll((node) => node.props.accessibilityLabel === 'Scroll to latest')
      ).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses measured content height when the first message fills an empty transcript', async () => {
    await render()

    await pressSend()
    expect(scrollToEnd).not.toHaveBeenCalled()

    await update({ folded: [assistantTurn('a1', 'First response')] })
    act(() => list().props.onContentSizeChange(320, 1_200))

    expect(scrollToOffset).toHaveBeenCalledOnce()
    expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1_200 })
  })

  it('resumes following when the drag that paged in history ends at the tail', async () => {
    vi.useFakeTimers()
    try {
      // A chat shorter than the screen: its top and its tail are the same place.
      const shortChat = scrollEvent(0, 400)
      const folded = [assistantTurn('a1', 'Short history')]
      const onLoadEarlier = vi.fn()
      await render({ folded, hasMore: true, onLoadEarlier })

      act(() => {
        list().props.onScrollBeginDrag?.({})
        list().props.onScroll(shortChat)
        list().props.onScrollEndDrag?.(shortChat)
      })
      await act(async () => {
        vi.advanceTimersByTime(200)
      })
      act(() => list().props.onContentSizeChange(320, 950))

      expect(onLoadEarlier).toHaveBeenCalledOnce()
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 950 })
      expect(
        renderer!.root.findAll((node) => node.props.accessibilityLabel === 'Scroll to latest')
      ).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pages in history only from a scroll the reader made', async () => {
    const onLoadEarlier = vi.fn()
    await render({ folded: [assistantTurn('a1', 'Latest')], hasMore: true, onLoadEarlier })
    const nearTop = scrollEvent(40, 520)

    // The tail pin of a chat barely taller than the screen reports an offset near the top too.
    act(() => list().props.onScroll(nearTop))
    expect(onLoadEarlier).not.toHaveBeenCalled()

    act(() => {
      list().props.onScrollBeginDrag?.({})
      list().props.onScroll(nearTop)
    })
    expect(onLoadEarlier).toHaveBeenCalledOnce()
  })

  it('anchors the first visible row, which the header above it is not', async () => {
    const folded = [assistantTurn('a1', 'History')]
    await render({ folded, hasMore: true })
    expect(list().props.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 1 })

    await update({ folded, hasMore: false })
    expect(list().props.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 0 })
  })

  describe('on the page, where the list reports no drag or momentum', () => {
    const observers = new Set<(entries: unknown[]) => void>()
    // The browser's resize step, before paint; RN Web's size report comes a task later.
    const resized = () => act(() => observers.forEach((deliver) => deliver([])))
    const page = () => renderer!.root.find((node) => node.type === 'ScrollView')
    const loadEarlier = () =>
      renderer!.root.find(
        (node) =>
          node.type === 'Pressable' &&
          node.findAll((text) => text.props.children === 'Load earlier messages').length > 0
      )

    beforeEach(() => {
      platform.OS = 'web'
      Object.assign(pageScroller, { scrollTop: 0, scrollHeight: 0, clientHeight: 500 })
      pageScroller.style.overflowAnchor = ''
      scrollToOffset.mockImplementation((to: { offset: number }) => {
        pageScroller.scrollTop = to.offset
      })
      observers.clear()
      vi.stubGlobal('ResizeObserver', function (deliver: (entries: unknown[]) => void) {
        return {
          observe: () => observers.add(deliver),
          unobserve: () => {},
          disconnect: () => observers.delete(deliver)
        }
      })
    })

    afterEach(() => {
      platform.OS = 'ios'
    })

    function scrolledTo(y: number, contentHeight: number) {
      Object.assign(pageScroller, { scrollTop: y, scrollHeight: contentHeight })
      return scrollEvent(y, contentHeight)
    }

    // RN Web's report and the scroller's own event, for one position.
    function scrollTo(y: number, contentHeight: number) {
      act(() => {
        page().props.onScroll(scrolledTo(y, contentHeight))
        pageScroller.scroll()
      })
    }

    it('holds a following reader at the live end through growth and a smaller viewport', async () => {
      const latest = [assistantTurn('a1', 'Latest')]
      const landed = [assistantTurn('a0', 'Older'), ...latest]
      const onLoadEarlier = vi.fn()
      await render({ folded: latest, hasMore: true, onLoadEarlier })
      scrollTo(500, 1_000)

      // Older rows land; the observer pins before paint.
      act(() => loadEarlier().props.onPress())
      await update({ folded: landed, hasMore: true, onLoadEarlier })
      pageScroller.scrollHeight = 5_000
      resized()
      expect(onLoadEarlier).toHaveBeenCalledOnce()
      expect(scrollToOffset).toHaveBeenCalledOnce()
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 4_500 })

      // The pin's own move, short of a reply that grew meanwhile, is not the reader's.
      scrollTo(4_500, 5_400)
      resized()
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 4_900 })

      // The browser clamping the scroll to a shorter end is layout's, not the reader's: it still
      // follows, and the next growth pins.
      scrollTo(3_500, 4_000)
      pageScroller.scrollHeight = 5_400
      resized()
      expect(scrollToOffset).toHaveBeenCalledTimes(3)
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 4_900 })
      scrollTo(4_900, 5_400)

      // The reader's wheel moves it up: it leaves the end.
      pageScroller.input('wheel')
      scrollTo(3_000, 5_400)
      pageScroller.scrollHeight = 6_000
      resized()
      expect(scrollToOffset).toHaveBeenCalledTimes(3)
      expect(
        renderer!.root.findAll((node) => node.props.accessibilityLabel === 'Scroll to latest')
      ).toHaveLength(1)

      // Back at the end it follows again, and a smaller viewport pins to the live end.
      scrollTo(5_500, 6_000)
      pageScroller.scrollHeight = 6_400
      resized()
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 5_900 })
      pageScroller.clientHeight = 300
      resized()
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 6_100 })
      expect(scrollToEnd).not.toHaveBeenCalled()
    })

    it('resumes an expired downward fling near the end, preserving small upward detachment', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
      vi.stubGlobal('navigator', { userAgent: 'Chrome' })
      const browserHolds = () => pageScroller.style.overflowAnchor === 'auto'
      await render({ folded: ['a1', 'a2', 'a3'].map((id) => assistantTurn(id, id)) })
      scrollTo(500, 1_000)
      resized()
      pageScroller.input('wheel')
      scrollTo(497, 1_000)
      // Expired input and geometry away from the end cannot detach or attach by themselves.
      now.mockReturnValue(11_100)
      pageScroller.scrollHeight = 1_200
      resized()
      expect(browserHolds()).toBe(true)
      scrollTo(632, 1_200)
      expect(browserHolds()).toBe(false)
      pageScroller.scrollHeight = 1_300
      resized()
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 800 })
      scrollTo(800, 1_300) // Deliver the pin's own scroll before the next reader movement.
      // The first upward movement can arrive in resize before its scroll event.
      pageScroller.input('wheel')
      pageScroller.scrollTop = 780
      resized()
      expect(browserHolds()).toBe(true)
      scrollTo(799, 1_300)
      expect(browserHolds()).toBe(false)
      now.mockRestore()
    })

    it('loads older history from the Load earlier control, not from reaching the top', async () => {
      const onLoadEarlier = vi.fn()
      await render({ folded: [assistantTurn('a1', 'Latest')], hasMore: true, onLoadEarlier })

      // Down to the top and into iOS's bounce past it.
      act(() => {
        page().props.onScroll(scrolledTo(40, 540))
        page().props.onScroll(scrolledTo(-15, 540))
      })
      expect(onLoadEarlier).not.toHaveBeenCalled()

      act(() => loadEarlier().props.onPress())
      expect(onLoadEarlier).toHaveBeenCalledOnce()
    })
  })

  it('starts an initially empty switched-to native chat following, preserving Tools', async () => {
    await render({ folded: [assistantTurn('a', 'A')] })
    act(() => renderer!.root.findByType('ChevronsUpDown').parent!.props.onPress())
    await scrollAwayFromTail()
    await update({ sendSurfaceId: 'tab-b', folded: [] })
    await update({ sendSurfaceId: 'tab-b', folded: [assistantTurn('b', 'B')] })
    act(() => list().props.onContentSizeChange(320, 1300))
    expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1300 })
    expect(renderedRow('b').props.toolsExpanded).toBe(true)
  })

  it('routes an accepted send through the immediate nonanimated tail owner', async () => {
    vi.useFakeTimers()
    try {
      const folded = [assistantTurn('a1', 'History')]
      await render({ folded })
      await act(async () => {
        vi.runOnlyPendingTimers()
      })
      await scrollAwayFromTail()
      scrollToEnd.mockClear()

      await pressSend()

      expect(scrollToEnd).toHaveBeenCalledOnce()
      expect(scrollToEnd).toHaveBeenLastCalledWith({ animated: false })
      await act(async () => {
        vi.advanceTimersByTime(60)
      })
      expect(scrollToEnd).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes the latest-message chevron through the tail owner and resumes following', async () => {
    const folded = [assistantTurn('a1', 'History')]
    await render({ folded })
    await scrollAwayFromTail()
    scrollToEnd.mockClear()

    const chevron = renderer!.root.find(
      (node) => node.props.accessibilityLabel === 'Scroll to latest'
    )
    act(() => chevron.props.onPress())
    expect(scrollToEnd).toHaveBeenLastCalledWith({ animated: false })

    act(() => list().props.onContentSizeChange(320, 1_300))
    expect(scrollToEnd).toHaveBeenCalledOnce()
    expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1_300 })
  })

  it('repins after a keyboard-driven viewport layout only while following', async () => {
    vi.useFakeTimers()
    try {
      const folded = [assistantTurn('a1', 'Latest')]
      await render({ folded })
      await act(async () => {
        vi.runOnlyPendingTimers()
      })
      scrollToEnd.mockClear()

      await update({ folded, keyboardInset: 320 })
      act(() => list().props.onLayout?.({ nativeEvent: { layout: { height: 400 } } }))

      expect(scrollToEnd).toHaveBeenCalledOnce()
      expect(scrollToEnd).toHaveBeenLastCalledWith({ animated: false })
      await act(async () => {
        vi.advanceTimersByTime(60)
      })
      expect(scrollToEnd).toHaveBeenCalledOnce()

      await scrollAwayFromTail()
      scrollToEnd.mockClear()
      await update({ folded, keyboardInset: 0 })
      act(() => list().props.onLayout?.({ nativeEvent: { layout: { height: 700 } } }))
      expect(scrollToEnd).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders an accepted optimistic image send without a queued state', async () => {
    await render({
      pending: [{ id: 'pending-1', text: 'look', images: ['file:///phone-photo.jpg'] }]
    })

    expect(listIds()).toEqual(['pending-1'])
    expect(renderedRow('pending-1').props).not.toHaveProperty('queued')
  })

  it('keeps a visible lock through a subscribed-end lease blip', async () => {
    vi.useFakeTimers()
    try {
      await render({ inputLockReason: 'waiting' })
      await act(async () => {
        vi.advanceTimersByTime(600)
      })
      expect(composer().props.disabled).toBe(true)

      await update({ inputLockReason: null })
      expect(composer().props.disabled).toBe(true)
      await act(async () => {
        vi.advanceTimersByTime(300)
      })
      await update({ inputLockReason: 'waiting' })
      await act(async () => {
        vi.advanceTimersByTime(600)
      })

      expect(composer().props.disabled).toBe(true)
      expect(composer().props.placeholder).toBe('Waiting for terminal…')
    } finally {
      vi.useRealTimers()
    }
  })

  it('unlocks after the lease stays ready', async () => {
    vi.useFakeTimers()
    try {
      await render({ inputLockReason: 'waiting' })
      await act(async () => {
        vi.advanceTimersByTime(600)
      })
      await update({ inputLockReason: null })
      await act(async () => {
        vi.advanceTimersByTime(599)
      })
      expect(composer().props.disabled).toBe(true)

      await act(async () => {
        vi.advanceTimersByTime(1)
      })

      expect(composer().props.disabled).toBe(false)
      expect(composer().props.placeholder).toBe('Message, @files, /commands')
    } finally {
      vi.useRealTimers()
    }
  })
  // Why: a terminal-backed send types into the agent's prompt and could answer it; drafting cannot.
  describe('a prompt card owns Send in terminal-backed chat', () => {
    const permission = { title: 'Approve?', options: [{ label: 'Allow', send: '1' }] }

    it('blocks only Send while the card shows, and frees it when the card clears', async () => {
      await render({ permission })
      expect(composer().props.sendDisabled).toBe(true)
      expect(composer().props.disabled).toBe(false)
      expect(composer().props.placeholder).toBe('Message, @files, /commands')

      await update({ permission: null })
      expect(composer().props.sendDisabled).toBe(false)
    })

    it('blocks Send for an ask and a heuristic question too', async () => {
      await render({
        ask: {
          questions: [{ question: 'Tabs?', multiSelect: false, options: [{ label: 'Tabs' }] }]
        }
      })
      expect(composer().props.sendDisabled).toBe(true)
      await update({
        question: { question: 'Name?', options: [], multiSelect: false, optionTokens: [] }
      })
      expect(composer().props.sendDisabled).toBe(true)
    })

    it('leaves a structured chat composer open: its host queues the send behind the prompt', async () => {
      await render({ permission, structuredActivityUi: true })
      expect(composer().props.sendDisabled).toBe(false)
    })
  })
})
