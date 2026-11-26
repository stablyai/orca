import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { documentQueryClient } from '../../test-support/rpc-recording/react-mounting/hook-mount'
import type { BotItemQuestionShape } from '../../../../src/shared/bots/bot-item-ask'
import { makeTestBotItem } from '../../../../src/shared/bots/bot-item.test-fixture'
import type { BotItem, BotItemEvent } from '../../../../src/shared/bots/bot-items'
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

const reply = (label: string) => ({ label, recommended: false })
const one: BotItemQuestionShape = {
  body: '',
  decisions: [{ question: 'Which branch?', replies: [reply('main'), reply('release')] }]
}
const two: BotItemQuestionShape = {
  body: '',
  decisions: [
    { question: 'Which branch?', replies: [reply('main'), reply('release')] },
    { question: 'Who reviews?', replies: [reply('Ana'), reply('Ben')] }
  ]
}

type Ask = { askId: string; shape: BotItemQuestionShape; open: number[] } | null
const ask1: Ask = { askId: 'e1', shape: one, open: [0] }

type Host = { item: BotItem; events: readonly BotItemEvent[] }

// The host's read: the ask it names (none: null) and the item's status, with no events loaded yet.
const read = (
  waitingAsk: string | null,
  status: BotItem['status'] = 'needs_you',
  events: readonly BotItemEvent[] = []
): Host => ({
  item: makeTestBotItem(1, { status, ...(waitingAsk ? { waitingAsk } : {}) }),
  events
})
const askEvent: BotItemEvent = {
  id: 'e1',
  kind: 'commented',
  actor: { kind: 'bot', botId: 'bot-a', chatId: 'chat-home' },
  data: {
    text: 'Which branch?',
    ask: {
      questions: [{ prompt: 'Which branch?', options: [{ label: 'main' }, { label: 'release' }] }]
    }
  },
  at: 1
}
const answerEvent: BotItemEvent = {
  id: 'e5',
  kind: 'commented',
  actor: { kind: 'owner' },
  data: { text: 'main' },
  at: 2
}

function Card({ itemKey, ask, host, send }: { itemKey: string; ask: Ask; host: Host; send: Send }) {
  return useMobileBotItemAskSlot({
    itemKey,
    ask,
    online: true,
    replying: false,
    loaded: true,
    host,
    onOpenWithCard: () => {},
    send
  }).card
}

function open(
  itemKey: string,
  ask: Ask = ask1,
  send: Send = () => {},
  host: Host = read(ask?.askId ?? null)
): void {
  const client = documentQueryClient()
  queries = client
  act(() => {
    tree = create(client.wrap(createElement(Card, { itemKey, ask, host, send })))
  })
}

// Mocked native leaves render as host strings.
const isHost = (node: { type: unknown }, name: string): boolean => node.type === name

const otherInput = (): ReactTestInstance | undefined =>
  tree!.root.findAll((node) => isHost(node, 'MessageBox'))[0]

const pressable = (label: string): ReactTestInstance =>
  tree!.root.find(
    (node) =>
      isHost(node, 'Pressable') && node.findAll((n) => n.props.children === label).length > 0
  )

function typeOther(text: string): void {
  if (!otherInput()) {
    const row = tree!.root.find((node) => node.props.label === 'Other…')
    act(() => row.props.onPress())
  }
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

it('keeps the whole card after a Send that didn’t go, though only one line changed since', async () => {
  const ask: Ask = { askId: 'e2', shape: two, open: [0, 1] }
  const send = vi.fn()
  open('host\0bot\0item-4', ask, send)
  typeOther('hotfix')
  await act(async () => pressable('Next').props.onPress())
  typeOther('Cam')
  await act(async () => pressable('Send').props.onPress())
  expect(send).toHaveBeenCalledTimes(1)
  // The host turned it down (too long, say): the card stays, and the first line is shortened.
  act(() => pressable('Step 1').props.onPress())
  typeOther('fix')
  await close()

  open('host\0bot\0item-4', ask, send)
  expect(otherInput()?.props.value).toBe('fix')
  act(() => pressable('Step 2').props.onPress())
  expect(otherInput()?.props.value).toBe('Cam')
})

it('keeps the card while the host names its ask, though the loaded history doesn’t show it yet', async () => {
  open('host\0bot\0item-5')
  typeOther('Ship it')
  await close()

  // The page read the item, but not yet the older events that hold the ask.
  open('host\0bot\0item-5', null, undefined, read('e1'))
  await close()
  open('host\0bot\0item-5')
  expect(otherInput()?.props.value).toBe('Ship it')
})

it('drops the card once the item closes', async () => {
  open('host\0bot\0item-7')
  typeOther('Ship it')
  await close()

  open('host\0bot\0item-7', null, undefined, read(null, 'done'))
  await close()
  open('host\0bot\0item-7')
  expect(otherInput()).toBeUndefined()
})

it('opens a newer ask’s card empty, and forgets the replaced ask’s words', async () => {
  open('host\0bot\0item-6')
  typeOther('For the first question')
  await close()

  open('host\0bot\0item-6', { askId: 'e9', shape: one, open: [0] })
  expect(otherInput()).toBeUndefined()
  await close()
  open('host\0bot\0item-6')
  expect(otherInput()).toBeUndefined()
})

it('drops the card once the loaded history shows its ask answered and the host names none', async () => {
  open('host\0bot\0item-8')
  typeOther('A long answer, never sent')
  await close()

  // Answered elsewhere (a short pick on desktop, say): the item works on, waiting on nothing.
  open('host\0bot\0item-8', null, undefined, read(null, 'working', [askEvent, answerEvent]))
  await close()
  open('host\0bot\0item-8')
  expect(otherInput()).toBeUndefined()
})

it('keeps the card when the host names no ask but its event isn’t loaded yet', async () => {
  open('host\0bot\0item-9')
  typeOther('Still typing')
  await close()

  open('host\0bot\0item-9', null, undefined, read(null, 'working'))
  await close()
  open('host\0bot\0item-9')
  expect(otherInput()?.props.value).toBe('Still typing')
})

it('keeps a newer ask’s card when an older item read still names the earlier ask', async () => {
  const newer: Ask = { askId: 'e9', shape: one, open: [0] }
  open('host\0bot\0item-10', newer)
  typeOther('For the newer question')
  await close()

  // A read split across two moments: the item from before e9, the events after it.
  open('host\0bot\0item-10', newer, undefined, read('e1'))
  await close()
  open('host\0bot\0item-10', newer)
  expect(otherInput()?.props.value).toBe('For the newer question')
})
