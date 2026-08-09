import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatView } from './MobileNativeChatView'

const { scrollToEnd } = vi.hoisted(() => ({ scrollToEnd: vi.fn() }))

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    FlatList: React.forwardRef((props: object, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollToEnd }))
      return React.createElement('FlatList', props)
    }),
    Pressable: 'Pressable',
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
vi.mock('./MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./MobileNativeChatPermission', () => ({ MobileNativeChatPermission: 'ChatPermission' }))
vi.mock('./MobileNativeChatQuestion', () => ({ MobileNativeChatQuestion: 'ChatQuestion' }))
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
  conversationIdentity?: string
  messages?: Parameters<typeof MobileNativeChatView>[0]['messages']
  folded?: Parameters<typeof MobileNativeChatView>[0]['folded']
  streaming?: string | null
  sendErrorMessage?: string | null
  onClearSendError?: () => void
  inputLockReason?: 'disconnected' | 'waiting' | null
  hasMore?: boolean
  loadingEarlier?: boolean
  onLoadEarlier?: Parameters<typeof MobileNativeChatView>[0]['onLoadEarlier']
  onSend?: (text: string) => Promise<boolean>
}

function suppressRendererWarning(): () => void {
  const original = console.error
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
      return
    }
    original(...args)
  })
  return () => spy.mockRestore()
}

function assistantTurn(id: string, text: string): NativeChatMessage {
  return { id, role: 'assistant', blocks: [{ type: 'text', text }], timestamp: 0, source: 'hook' }
}

function deferredPage(): {
  onLoadEarlier: ReturnType<typeof vi.fn<() => Promise<boolean>>>
  resolve: (madeProgress: boolean) => void
} {
  let resolve = (_madeProgress: boolean): void => {
    throw new Error('Page request did not start')
  }
  const onLoadEarlier = vi.fn(() => new Promise<boolean>((settle) => (resolve = settle)))
  return { onLoadEarlier, resolve: (madeProgress) => resolve(madeProgress) }
}

function chatViewElement(overrides: Overrides): ReturnType<typeof createElement> {
  const messages = overrides.messages ?? []
  return createElement(MobileNativeChatView, {
    conversationIdentity: 'test-conversation',
    messages,
    folded: overrides.folded ?? messages,
    status: 'ready',
    streaming: null,
    onSend: vi.fn().mockResolvedValue(true),
    pending: [],
    composerText: '',
    onComposerTextChange: vi.fn(),
    ...overrides
  })
}

describe('MobileNativeChatView', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    scrollToEnd.mockClear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function render(overrides: Overrides = {}): Promise<void> {
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(chatViewElement(overrides))
      })
    } finally {
      restore()
    }
  }

  async function update(overrides: Overrides = {}): Promise<void> {
    await act(async () => {
      renderer?.update(chatViewElement(overrides))
    })
  }

  /** Ids of the rows the list is currently rendering. */
  function listIds(): string[] {
    const list = renderer!.root.find((node) => node.type === 'FlatList')
    return (list.props.data as { id: string }[]).map((row) => row.id)
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

  const message = {
    id: 'current',
    role: 'assistant' as const,
    blocks: [{ type: 'text' as const, text: 'current' }],
    timestamp: 0,
    source: 'transcript' as const
  }
  const older = { ...message, id: 'older', blocks: [{ type: 'text' as const, text: 'older' }] }

  function list(): ReactTestInstance {
    return renderer!.root.find((node) => node.type === 'FlatList')
  }

  function pressLoadEarlier(): void {
    list().props.ListHeaderComponent.props.onPress()
  }

  function scroll(offset: number, contentHeight: number, viewportHeight: number): void {
    list().props.onScroll({
      nativeEvent: {
        contentOffset: { y: offset },
        contentSize: { height: contentHeight },
        layoutMeasurement: { height: viewportHeight }
      }
    })
  }

  it('anchors a prepend and stays detached until the user returns to the tail', async () => {
    vi.useFakeTimers()
    try {
      const page = deferredPage()
      await render({ messages: [message], hasMore: true, onLoadEarlier: page.onLoadEarlier })
      await act(async () => vi.runAllTimersAsync())
      scrollToEnd.mockClear()

      act(pressLoadEarlier)
      await update({
        messages: [message],
        hasMore: true,
        loadingEarlier: true,
        onLoadEarlier: page.onLoadEarlier
      })
      act(() => list().props.onContentSizeChange(0, 600))
      await update({
        messages: [older, message],
        hasMore: false,
        loadingEarlier: false,
        onLoadEarlier: page.onLoadEarlier
      })
      await act(async () => {
        page.resolve(true)
        await Promise.resolve()
      })
      expect(list().props.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 0 })
      act(() => list().props.onContentSizeChange(0, 1200))
      await act(async () => vi.advanceTimersByTimeAsync(60_000))

      const appended = { ...message, id: 'appended' }
      await update({ messages: [older, message, appended], hasMore: false })
      act(() => list().props.onContentSizeChange(0, 1400))
      await act(async () => vi.runAllTimersAsync())
      expect(scrollToEnd).not.toHaveBeenCalled()

      act(() => {
        list().props.onScrollBeginDrag()
        scroll(800, 1400, 600)
        list().props.onScrollEndDrag()
      })
      await act(async () => vi.advanceTimersByTimeAsync(0))
      const latest = { ...message, id: 'latest' }
      await update({ messages: [older, message, appended, latest], hasMore: false })
      act(() => list().props.onContentSizeChange(0, 1500))

      expect(scrollToEnd).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not follow new output during an arbitrarily slow history request', async () => {
    vi.useFakeTimers()
    try {
      const page = deferredPage()
      await render({ messages: [message], hasMore: true, onLoadEarlier: page.onLoadEarlier })
      await act(async () => vi.runAllTimersAsync())
      scrollToEnd.mockClear()

      act(pressLoadEarlier)
      await update({
        messages: [message],
        hasMore: true,
        loadingEarlier: true,
        onLoadEarlier: page.onLoadEarlier
      })
      await act(async () => vi.advanceTimersByTimeAsync(60_000))
      const appended = { ...message, id: 'appended' }
      await update({
        messages: [message, appended],
        hasMore: true,
        loadingEarlier: true,
        onLoadEarlier: page.onLoadEarlier
      })
      act(() => list().props.onContentSizeChange(0, 900))
      await act(async () => vi.runAllTimersAsync())

      expect(scrollToEnd).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a history completion after unmount', async () => {
    vi.useFakeTimers()
    try {
      const page = deferredPage()
      await render({ messages: [message], hasMore: true, onLoadEarlier: page.onLoadEarlier })
      await act(async () => vi.runAllTimersAsync())
      scrollToEnd.mockClear()

      act(pressLoadEarlier)
      act(() => renderer?.unmount())
      renderer = null
      await act(async () => {
        page.resolve(false)
        await Promise.resolve()
        await vi.runAllTimersAsync()
      })

      expect(scrollToEnd).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels an armed tail-follow before requesting history', async () => {
    vi.useFakeTimers()
    try {
      const page = deferredPage()
      await render({ messages: [message], hasMore: true, onLoadEarlier: page.onLoadEarlier })
      await act(async () => vi.runAllTimersAsync())
      scrollToEnd.mockClear()

      const appended = { ...message, id: 'appended' }
      await update({
        messages: [message, appended],
        hasMore: true,
        onLoadEarlier: page.onLoadEarlier
      })
      await act(async () => vi.advanceTimersByTimeAsync(30))
      act(pressLoadEarlier)
      await act(async () => vi.advanceTimersByTimeAsync(60))

      expect(page.onLoadEarlier).toHaveBeenCalledOnce()
      expect(scrollToEnd).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the native anchor config stable across streaming renders', async () => {
    await render({ messages: [message] })
    const config = list().props.maintainVisibleContentPosition

    await update({ messages: [message], streaming: 'partial response' })

    expect(list().props.maintainVisibleContentPosition).toBe(config)
  })

  it('auto-pages only from a gesture without reattaching a short transcript', async () => {
    vi.useFakeTimers()
    try {
      const page = deferredPage()
      await render({ messages: [message], hasMore: true, onLoadEarlier: page.onLoadEarlier })
      await act(async () => vi.runAllTimersAsync())
      scrollToEnd.mockClear()

      act(() => scroll(0, 600, 600))
      expect(page.onLoadEarlier).not.toHaveBeenCalled()

      act(() => {
        list().props.onScrollBeginDrag()
        scroll(0, 600, 600)
      })
      await update({
        messages: [message],
        hasMore: true,
        loadingEarlier: true,
        onLoadEarlier: page.onLoadEarlier
      })
      await update({
        messages: [older, message],
        hasMore: false,
        onLoadEarlier: page.onLoadEarlier
      })
      await act(async () => {
        page.resolve(true)
        await Promise.resolve()
      })
      act(() => {
        list().props.onScrollEndDrag()
        list().props.onContentSizeChange(0, 1200)
      })
      await act(async () => vi.runAllTimersAsync())

      expect(page.onLoadEarlier).toHaveBeenCalledOnce()
      expect(scrollToEnd).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not mistake programmatic momentum for a user gesture', async () => {
    vi.useFakeTimers()
    try {
      await render({ messages: [message] })
      await act(async () => vi.runAllTimersAsync())
      scrollToEnd.mockClear()

      act(() => {
        list().props.onMomentumScrollBegin()
        scroll(0, 1200, 600)
        list().props.onMomentumScrollEnd()
      })
      await update({ messages: [message, { ...message, id: 'appended' }] })
      act(() => list().props.onContentSizeChange(0, 1400))

      expect(scrollToEnd).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays detached while a drag hands off to momentum', async () => {
    vi.useFakeTimers()
    try {
      await render({ messages: [message] })
      await act(async () => vi.runAllTimersAsync())
      scrollToEnd.mockClear()

      act(() => {
        list().props.onScrollBeginDrag()
        scroll(600, 1200, 600)
        list().props.onScrollEndDrag()
        list().props.onContentSizeChange(0, 1400)
        list().props.onMomentumScrollBegin()
      })

      expect(scrollToEnd).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets scroll-to-latest override an in-flight history detach', async () => {
    vi.useFakeTimers()
    try {
      const page = deferredPage()
      await render({ messages: [message], hasMore: true, onLoadEarlier: page.onLoadEarlier })
      await act(async () => vi.runAllTimersAsync())
      scrollToEnd.mockClear()

      act(pressLoadEarlier)
      await update({
        messages: [message],
        hasMore: true,
        loadingEarlier: true,
        onLoadEarlier: page.onLoadEarlier
      })
      act(() => scroll(0, 1200, 600))
      const latest = renderer!.root.find(
        (node) => node.props.accessibilityLabel === 'Scroll to latest'
      )
      act(() => latest.props.onPress())
      expect(scrollToEnd).toHaveBeenLastCalledWith({ animated: true })

      scrollToEnd.mockClear()
      await update({
        messages: [older, message],
        hasMore: false,
        onLoadEarlier: page.onLoadEarlier
      })
      await act(async () => {
        page.resolve(true)
        await Promise.resolve()
      })
      act(() => list().props.onContentSizeChange(0, 1400))

      expect(scrollToEnd).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores tail-follow when a history request makes no progress', async () => {
    vi.useFakeTimers()
    try {
      const page = deferredPage()
      await render({ messages: [message], hasMore: true, onLoadEarlier: page.onLoadEarlier })
      await act(async () => vi.runAllTimersAsync())
      scrollToEnd.mockClear()

      act(pressLoadEarlier)
      await act(async () => {
        page.resolve(false)
        await Promise.resolve()
      })
      await act(async () => vi.runAllTimersAsync())

      expect(scrollToEnd).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles a completed page without observing a loading render', async () => {
    vi.useFakeTimers()
    try {
      const onLoadEarlier = vi.fn().mockResolvedValue(true)
      await render({ messages: [message], hasMore: true, onLoadEarlier })
      await act(async () => vi.runAllTimersAsync())
      scrollToEnd.mockClear()

      act(pressLoadEarlier)
      await act(async () => {
        await Promise.resolve()
      })
      await update({ messages: [older, message], hasMore: false })
      act(() => list().props.onContentSizeChange(0, 1200))

      expect(onLoadEarlier).toHaveBeenCalledOnce()
      expect(scrollToEnd).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores tail-follow when a history request is rejected synchronously', async () => {
    vi.useFakeTimers()
    try {
      const onLoadEarlier = vi.fn(() => null)
      await render({ messages: [message], hasMore: true, onLoadEarlier })
      await act(async () => vi.runAllTimersAsync())
      scrollToEnd.mockClear()

      act(() => list().props.ListHeaderComponent.props.onPress())
      await act(async () => vi.runAllTimersAsync())

      expect(onLoadEarlier).toHaveBeenCalledOnce()
      expect(scrollToEnd).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets tail-follow when the conversation changes', async () => {
    vi.useFakeTimers()
    try {
      const page = deferredPage()
      await render({ messages: [message], hasMore: true, onLoadEarlier: page.onLoadEarlier })
      await act(async () => vi.runAllTimersAsync())
      scrollToEnd.mockClear()

      act(pressLoadEarlier)
      await update({
        messages: [older, message],
        hasMore: false,
        onLoadEarlier: page.onLoadEarlier
      })
      await act(async () => {
        page.resolve(true)
        await Promise.resolve()
      })
      scrollToEnd.mockClear()

      await update({
        conversationIdentity: 'next-conversation',
        messages: [message, { ...message, id: 'next' }],
        hasMore: false
      })
      await act(async () => vi.runAllTimersAsync())

      expect(scrollToEnd).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
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

  it('keeps a visible lock through a subscribed-end lease blip', async () => {
    vi.useFakeTimers()
    try {
      await render({ inputLockReason: 'waiting' })
      await act(async () => vi.advanceTimersByTime(600))
      expect(composer().props.disabled).toBe(true)

      await update({ inputLockReason: null })
      expect(composer().props.disabled).toBe(true)
      await act(async () => vi.advanceTimersByTime(300))
      await update({ inputLockReason: 'waiting' })
      await act(async () => vi.advanceTimersByTime(600))

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
      await act(async () => vi.advanceTimersByTime(600))
      await update({ inputLockReason: null })
      await act(async () => vi.advanceTimersByTime(599))
      expect(composer().props.disabled).toBe(true)

      await act(async () => vi.advanceTimersByTime(1))

      expect(composer().props.disabled).toBe(false)
      expect(composer().props.placeholder).toBe('Message, @files, /commands')
    } finally {
      vi.useRealTimers()
    }
  })
})
