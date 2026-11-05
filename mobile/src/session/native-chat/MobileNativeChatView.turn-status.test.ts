import './MobileNativeChatView.harness.test-fixture'
import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import { MobileNativeChatView } from './MobileNativeChatView'

const scrollToEnd = vi.hoisted(() => vi.fn())
const scrollToOffset = vi.hoisted(() => vi.fn())

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ...(await import('../../test-support/react-native-motion-stub')).reactNativeMotionStub(),
    ActivityIndicator: 'ActivityIndicator',
    FlatList: React.forwardRef<
      unknown,
      {
        data: NativeChatMessage[]
        renderItem: (row: { item: NativeChatMessage; index: number }) => ReactNode
        ListFooterComponent: ReactNode
      }
    >((props, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollToEnd, scrollToOffset }), [])
      return React.createElement(
        'FlatList',
        props,
        props.data.map((item, index) =>
          React.createElement(React.Fragment, { key: item.id }, props.renderItem({ item, index }))
        ),
        props.ListFooterComponent
      )
    }),
    Platform: { OS: 'ios', select: (specifics: { ios?: unknown }) => specifics.ios },
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

vi.mock('./transcript/MobileNativeChatMessage', () => ({
  MobileNativeChatMessage: 'ChatMessage'
}))
vi.mock('./transcript/MobileNativeChatLiveLine', () => ({
  MobileNativeChatLiveLine: 'LiveStatus'
}))
vi.mock('./input/MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./input/MobileNativeChatPermission', () => ({
  MobileNativeChatPermission: 'ChatPermission'
}))
vi.mock('./input/MobileNativeChatQuestion', () => ({
  MobileNativeChatQuestion: 'ChatQuestion'
}))
vi.mock('../../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))

vi.mock('./composer/MobileNativeChatComposer', async () => {
  const { composerStub } = await import('./MobileNativeChatView.render-stubs.test-fixture')
  return composerStub()
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
    getComposerEditGeneration: () => 0,
    pending: [],
    draftKey: null,
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

  function renderedRow(id: string): ReturnType<typeof createElement> {
    return createElement(
      'Row',
      renderer!.root.find(
        (node) => String(node.type) === 'ChatMessage' && node.props.message.id === id
      ).props
    )
  }

  describe('structured turn status wiring', () => {
    const userTurn = (id: string, text: string): NativeChatMessage => ({
      id,
      role: 'user',
      blocks: [{ type: 'text', text }],
      timestamp: 0,
      source: 'transcript'
    })

    function rowProps(id: string): Record<string, unknown> {
      return (renderedRow(id) as { props: Record<string, unknown> }).props
    }

    it('does not carry a running turn clock across chat surfaces', async () => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(1_000)
        const firstTab = [userTurn('u1', 'first')]
        await render({
          messages: firstTab,
          folded: firstTab,
          structuredActivityUi: true,
          agentWorking: true,
          sendSurfaceId: 'host\0worktree\0tab-a'
        })
        expect(rowProps('u1').turnStatus).toMatchObject({ startedAt: 1_000 })

        vi.setSystemTime(12_000)
        const secondTab = [userTurn('u2', 'second')]
        await update({
          messages: secondTab,
          folded: secondTab,
          structuredActivityUi: true,
          agentWorking: true,
          sendSurfaceId: 'host\0worktree\0tab-b'
        })

        expect(rowProps('u2').turnStatus).toMatchObject({ startedAt: 12_000 })
      } finally {
        vi.useRealTimers()
      }
    })
  })
})

vi.mock('../MobileQueuedMessageComposer', () => ({
  MobileQueuedMessageComposer: 'QueuedMessageComposer'
}))
