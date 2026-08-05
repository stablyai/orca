import { createElement, isValidElement, type ReactElement } from 'react'
import { AccessibilityInfo } from 'react-native'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatView } from './MobileNativeChatView'

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  ActivityIndicator: 'ActivityIndicator',
  FlatList: 'FlatList',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

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
    MobileNativeChatComposer: (props: { onSend: (text: string) => Promise<boolean> }) =>
      React.createElement('Composer', {
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
  hasMore?: boolean
  loadingEarlier?: boolean
  loadEarlierError?: string | null
  onLoadEarlier?: () => void
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

function chatViewElement(overrides: Overrides): ReturnType<typeof createElement> {
  return createElement(MobileNativeChatView, {
    messages: [],
    folded: [],
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
    vi.mocked(AccessibilityInfo.announceForAccessibility).mockClear()
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

  function bannerText(): string {
    const [alert, ...rest] = banners()
    expect(rest).toHaveLength(0)
    return alert
      .findAll((node) => node.type === 'Text')
      .map((node) => node.props.children)
      .join('')
  }

  // The list is a string stand-in, so its header lives as an unrendered element
  // on the prop; read it directly rather than through the rendered tree.
  function loadEarlierHeader(): ReactElement<Record<string, unknown>> {
    const list = renderer!.root.find((node) => node.type === 'FlatList')
    return list.props.ListHeaderComponent as ReactElement<Record<string, unknown>>
  }

  function headerText(element: unknown): string {
    if (typeof element === 'string') {
      return element
    }
    if (Array.isArray(element)) {
      return element.map((entry) => headerText(entry)).join(' ')
    }
    if (isValidElement<{ children?: unknown }>(element)) {
      return headerText(element.props.children)
    }
    return ''
  }

  function scrollToTop(): void {
    const list = renderer!.root.find((node) => node.type === 'FlatList')
    act(() => {
      list.props.onScroll({
        nativeEvent: {
          contentOffset: { y: 0 },
          contentSize: { height: 1000 },
          layoutMeasurement: { height: 400 }
        }
      })
    })
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

  // The gate that decides `streaming` lives in MobileNativeChatOverlay, which
  // outlives this view; see MobileNativeChatOverlay.test.ts.
  it('appends the gated streaming bubble after the folded transcript', async () => {
    const folded = [assistantTurn('a1', 'The tests pass.')]
    await render({ folded })
    expect(listIds()).toEqual(['a1'])

    await update({ folded, streaming: 'The tests' })

    expect(listIds()).toEqual(['a1', 'streaming'])
  })

  it('pages in older history automatically near the top', async () => {
    const onLoadEarlier = vi.fn()
    await render({ hasMore: true, onLoadEarlier })

    scrollToTop()

    expect(onLoadEarlier).toHaveBeenCalledOnce()
  })

  it('blocks automatic paging but keeps explicit retry after loading earlier fails', async () => {
    const onLoadEarlier = vi.fn()
    await render({
      hasMore: true,
      loadEarlierError: 'Couldn’t load earlier messages',
      onLoadEarlier
    })

    scrollToTop()
    scrollToTop()
    expect(onLoadEarlier).not.toHaveBeenCalled()

    act(() => (loadEarlierHeader().props.onPress as () => void)())
    expect(onLoadEarlier).toHaveBeenCalledOnce()
  })

  it('surfaces the failure and a retry affordance in the header row', async () => {
    await render({ hasMore: true, loadEarlierError: 'Couldn’t load earlier messages' })

    const header = loadEarlierHeader()
    expect(headerText(header)).toContain('Couldn’t load earlier messages')
    expect(headerText(header)).toContain('Tap to retry')
    expect(header.props.accessibilityLabel).toBe('Couldn’t load earlier messages. Tap to retry')
    expect(header.props.accessibilityState).toEqual({ busy: false, disabled: false })
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      'Couldn’t load earlier messages. Tap to retry'
    )
  })

  // An in-flight retry outranks the failure it is retrying, so the header shows
  // the spinner rather than a stale error the user has already acted on.
  it('disables the header and hides the failure while a retry is in flight', async () => {
    await render({
      hasMore: true,
      loadingEarlier: true,
      loadEarlierError: 'Couldn’t load earlier messages',
      onLoadEarlier: vi.fn()
    })

    const header = loadEarlierHeader()
    expect(header.props.disabled).toBe(true)
    expect(header.props.accessibilityLabel).toBe('Loading earlier messages')
    expect(header.props.accessibilityState).toEqual({ busy: true, disabled: true })
    expect(headerText(header)).not.toContain('Couldn’t load earlier messages')
    expect(headerText(header)).not.toContain('Tap to retry')
    expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalled()
  })
})
