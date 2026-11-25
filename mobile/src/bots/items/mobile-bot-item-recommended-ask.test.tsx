// The phone's ask card for a stored ask, mounted with react-test-renderer: its rows as shown, then
// the options and Send pressed, and the comment the card posts. Covers the component, not native
// touch delivery or VoiceOver/TalkBack output.
import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { documentQueryClient } from '../../test-support/rpc-recording/react-mounting/hook-mount'
import { botItemAskText, type BotItemAsk } from '../../../../src/shared/bots/bot-item-ask'
import {
  RECOMMENDED_ASKS,
  RECOMMENDED_ASK_ANSWERS
} from '../../../../src/shared/bots/bot-item-ask-recommended.test-fixture'
import { makeTestBotItem } from '../../../../src/shared/bots/bot-item.test-fixture'
import type { BotItemEvent } from '../../../../src/shared/bots/bot-items'
import { NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS } from '../../../../src/shared/native-chat/input/questions/native-chat-question-auto-advance'
import { MobileNativeChatAskOptionRow } from '../../session/native-chat/input/prompts/MobileNativeChatAskOptionRow'
import { botItemOpenAsk, useMobileBotItemAskSlot } from './MobileBotItemAskCard'

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
vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
  X: 'X'
}))
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

let tree: ReactTestRenderer | null = null
let queries: ReturnType<typeof documentQueryClient> | null = null
afterEach(async () => {
  if (tree) {
    act(() => tree!.unmount())
  }
  tree = null
  vi.useRealTimers()
  await queries?.end()
  queries = null
})

type Sent = { text: string; askId: string; skipped: readonly number[] }

/** The item's waiting ask, as the host stored it, in the card its page docks. */
let mounts = 0
function mount(ask: BotItemAsk): Sent[] {
  const text = botItemAskText(ask)
  const event: BotItemEvent = {
    id: 'e2',
    kind: 'commented',
    actor: { kind: 'bot', botId: 'bot-a', chatId: 'chat-home' },
    data: { text, ask },
    at: 1
  }
  const item = makeTestBotItem(7, { status: 'needs_you', question: { eventId: 'e2', text } })
  const sent: Sent[] = []
  const key = `host:item-${++mounts}`
  function Card(): React.JSX.Element | null {
    const slot = useMobileBotItemAskSlot({
      // Each mount its own item, so no card keeps another's unsent picks.
      itemKey: key,
      ask: botItemOpenAsk(item, [event]),
      host: { item, events: [event] },
      online: true,
      replying: false,
      loaded: true,
      onOpenWithCard: () => {},
      send: (words, answering) => sent.push({ text: words, ...answering })
    })
    return slot.card
  }
  queries = documentQueryClient()
  act(() => {
    tree = create(queries!.wrap(createElement(Card)))
  })
  return sent
}

const isHost = (node: { type: unknown }, name: string): boolean => node.type === name
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')
// The ask's own options; Other… for your own words is the card's.
const rows = (): ReactTestInstance[] =>
  tree!.root
    .findAllByType(MobileNativeChatAskOptionRow)
    .filter((row) => row.props.label !== 'Other…')
/** What each row reads: its label, then the pill when it shows one. */
const shown = (): string[] =>
  rows().map((row) =>
    textOf(
      row.find(
        (node) => isHost(node, 'Text') && node.parent !== null && isHost(node.parent, 'View')
      )
    )
  )
const footer = (label: string): ReactTestInstance =>
  tree!.root.find(
    (node) =>
      isHost(node, 'Pressable') && node.findAll((n) => n.props.children === label).length > 0
  )

async function press(label: string): Promise<void> {
  const row = rows().find((node) => node.props.label === label)!
  act(() => row.props.onPress())
  await act(async () => {
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS)
  })
}
async function send(): Promise<void> {
  await act(async () => footer('Send').props.onPress())
}

it('shows a cleaned recommendation once and posts its label as stored', async () => {
  vi.useFakeTimers()
  const sent = mount(RECOMMENDED_ASKS.written.stored)
  expect(shown()).toEqual(['Waive; ship it disclosed  Recommended', 'Fix it first'])
  // A pick of one sends it, as the card does; pick several waits for Send.
  await press('Waive; ship it disclosed')
  expect(sent).toEqual([{ text: RECOMMENDED_ASK_ANSWERS.written, askId: 'e2', skipped: [] }])
})

it('reads a twin that kept its words with its own one pill, apart from the plain twin', async () => {
  vi.useFakeTimers()
  const sent = mount(RECOMMENDED_ASKS.twin.stored)
  expect(shown()).toEqual(['Go', 'Go  Recommended'])
  await press('Go (Recommended)')
  expect(sent.map((entry) => entry.text)).toEqual([RECOMMENDED_ASK_ANSWERS.twin])
})

it('posts two picks and the bundled option as different answers to the same ask', async () => {
  vi.useFakeTimers()
  const two = mount(RECOMMENDED_ASKS.joined.stored)
  expect(new Set(shown()).size).toBe(3)
  await press('Audit')
  await press('Notify')
  await send()
  act(() => tree!.unmount())
  tree = null
  await queries!.end()
  const bundled = mount(RECOMMENDED_ASKS.joined.stored)
  await press('Audit, Notify (Recommended)')
  await send()
  expect([two[0]?.text, bundled[0]?.text]).toEqual([
    RECOMMENDED_ASK_ANSWERS.joinedTwo,
    RECOMMENDED_ASK_ANSWERS.joinedBundled
  ])
})

it('steps several questions, one pill each, and posts both answers in one comment', async () => {
  vi.useFakeTimers()
  const sent = mount(RECOMMENDED_ASKS.several.stored)
  expect(shown().filter((words) => words.endsWith('Recommended'))).toEqual(['Ship it  Recommended'])
  await press('Ship it')
  expect(shown().filter((words) => words.endsWith('Recommended'))).toEqual(['No  Recommended'])
  // The last pick of several sends the set, as the card does after its last question.
  await press('No')
  expect(sent).toEqual([{ text: RECOMMENDED_ASK_ANSWERS.several, askId: 'e2', skipped: [] }])
})
