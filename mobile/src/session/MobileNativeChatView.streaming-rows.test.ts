import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatView } from './MobileNativeChatView'

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    FlatList: React.forwardRef((props, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollToEnd: vi.fn(), scrollToOffset: vi.fn() }), [])
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
  const chain = { runOnJS: () => chain, onStart: () => chain, onUpdate: () => chain }
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
vi.mock('./MobileNativeChatPromptCard', () => ({ MobileNativeChatPromptCard: 'PromptCard' }))
vi.mock('./MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./MobileNativeChatPermission', () => ({ MobileNativeChatPermission: 'ChatPermission' }))
vi.mock('./MobileNativeChatQuestion', () => ({ MobileNativeChatQuestion: 'ChatQuestion' }))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('./MobileAgentWorkingIndicator', () => ({
  MobileAgentWorkingIndicator: 'WorkingIndicator'
}))
vi.mock('./MobileNativeChatComposer', () => ({ MobileNativeChatComposer: 'Composer' }))

function row(id: string, role: NativeChatMessage['role'], text: string): NativeChatMessage {
  return { id, role, blocks: [{ type: 'text', text }], timestamp: 0, source: 'transcript' }
}

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

function show(folded: NativeChatMessage[]): void {
  const element = createElement(MobileNativeChatView, {
    messages: folded,
    folded,
    status: 'ready',
    streaming: null,
    structuredActivityUi: true,
    agentWorking: true,
    // The host rebuilds its settled-turn map on every batch, with equal values.
    settledTurns: new Map([['u1', { startedAt: 1_000, workedSeconds: 4 }]]),
    onSend: vi.fn().mockResolvedValue(true),
    sendSurfaceId: 'tab-a',
    getSendCompletionGeneration: () => 0,
    getComposerEditGeneration: () => 0,
    pending: [],
    composerText: '',
    onComposerTextChange: vi.fn()
  })
  act(() => {
    if (renderer) {
      renderer.update(element)
    } else {
      renderer = create(element)
    }
  })
}

function list(): ReactTestInstance {
  return renderer!.root.find((node) => Object.is(node.type, 'FlatList'))
}

function settledStatus(): unknown {
  const data: NativeChatMessage[] = list().props.data
  return list().props.renderItem({ item: data[0], index: 0 }).props.turnStatus
}

it('keeps renderItem and settled rows while a structured reply streams', () => {
  const history = [
    row('u1', 'user', 'go'),
    row('a1', 'assistant', 'done'),
    row('u2', 'user', 'next')
  ]
  show([...history, row('a2', 'assistant', 'Hel')])
  // A stable renderItem only spares unchanged cells when the list memoizes its renderer.
  expect(list().props.strictMode).toBe(true)
  const renderItem = list().props.renderItem
  const status = settledStatus()
  expect(status).toMatchObject({ workedSeconds: 4 })

  show([...history, row('a2', 'assistant', 'Hello')])
  expect(list().props.renderItem).toBe(renderItem)
  expect(settledStatus()).toBe(status)

  show([...history, row('a2', 'assistant', 'Hello'), row('u3', 'user', 'more')])
  expect(list().props.renderItem).not.toBe(renderItem)
  expect(settledStatus()).toBe(status)
})
