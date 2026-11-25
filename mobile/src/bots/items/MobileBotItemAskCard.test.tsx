import { createElement, type ReactElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { documentQueryClient } from '../../test-support/rpc-recording/react-mounting/hook-mount'
import type { BotItemQuestionShape } from '../../../../src/shared/bots/bot-item-ask'
import { useMobileBotItemAskSlot } from './MobileBotItemAskCard'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }
}))
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Keyboard: { dismiss: () => {} },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  Linking: { openURL: () => Promise.resolve() },
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios }
}))
vi.mock('lucide-react-native', () => ({ Check: 'Check', ChevronDown: 'ChevronDown', X: 'X' }))
vi.mock(
  '../../session/native-chat/transcript/message-content/MobileNativeChatQuestionText',
  async () => {
    const React = await import('react')
    return {
      MobileNativeChatQuestionText: ({ content }: { content: string }) =>
        React.createElement('Text', null, content)
    }
  }
)
vi.mock('../../components/composer-input/MessageBox', () => ({ MessageBox: 'MessageBox' }))
vi.mock(
  '../../session/native-chat/input/session-options/MobileNativeChatOptionPreviewSheet',
  () => ({
    MobileNativeChatOptionPreviewSheet: 'OptionPreviewSheet'
  })
)

type Send = (text: string, answering: { askId: string; skipped: readonly number[] }) => void

let tree: ReactTestRenderer | null = null
let queries: ReturnType<typeof documentQueryClient> | null = null

// Leaving the item: its page, and the card with it, unmounts.
async function close(): Promise<void> {
  if (tree) {
    const shown = tree
    act(() => shown.unmount())
    tree = null
  }
  await queries?.end()
  queries = null
}

afterEach(close)

const shape: BotItemQuestionShape = {
  body: '',
  decisions: [
    {
      question: 'Which branch?',
      replies: [
        { label: 'main', recommended: false },
        { label: 'release', recommended: false }
      ]
    }
  ]
}

function Card({ itemKey, send }: { itemKey: string; send: Send }): ReactElement | null {
  return useMobileBotItemAskSlot({
    itemKey,
    ask: { askId: 'ask-1', shape, open: [0] },
    online: true,
    replying: false,
    loaded: true,
    onOpenWithCard: () => {},
    send
  }).card
}

function open(itemKey: string, send: Send = () => {}): void {
  const client = documentQueryClient()
  queries = client
  act(() => {
    tree = create(client.wrap(createElement(Card, { itemKey, send })))
  })
}

const otherInput = (): ReactTestInstance | undefined =>
  tree!.root.findAll((node) => node.type === 'MessageBox')[0]

function typeOther(text: string): void {
  const row = tree!.root.find((node) => node.props.label === 'Other…')
  act(() => row.props.onPress())
  act(() => otherInput()!.props.onChangeText(text))
}

it('opens the answer card again with the words typed before the item closed', async () => {
  open('host\0bot\0item-1')
  typeOther('Use the hotfix branch')
  await close()

  open('host\0bot\0item-1')
  expect(otherInput()?.props.value).toBe('Use the hotfix branch')
})

it('keeps one item’s typed words off another item', async () => {
  open('host\0bot\0item-2')
  typeOther('Only for item 2')
  await close()

  open('host\0bot\0item-3')
  expect(otherInput()).toBeUndefined()
})

it('forgets the typed words once they are sent', async () => {
  const send = vi.fn()
  open('host\0bot\0item-4', send)
  typeOther('Ship it')
  const footerSend = tree!.root.find(
    (node) =>
      node.type === 'Pressable' && node.findAll((n) => n.props.children === 'Send').length > 0
  )
  await act(async () => footerSend.props.onPress())
  expect(send).toHaveBeenCalledWith('Ship it', { askId: 'ask-1', skipped: [] })
  await close()

  open('host\0bot\0item-4', send)
  expect(otherInput()).toBeUndefined()
})
