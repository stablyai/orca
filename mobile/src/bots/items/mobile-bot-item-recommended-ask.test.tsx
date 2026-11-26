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
import { MobileNativeChatAsk } from '../../session/native-chat/input/prompts/MobileNativeChatAsk'
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
  Pencil: 'Pencil',
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
// The ask's own options. The card's free-text row is told apart by what it is, not its words: on an
// item's ask it is an action (`action`), on an agent prompt the row after the options.
const allRows = (): ReactTestInstance[] => tree!.root.findAllByType(MobileNativeChatAskOptionRow)
const freeText = (): ReactTestInstance => allRows().at(-1)!
const rows = (): ReactTestInstance[] => allRows().slice(0, -1)
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

it('reads a twin that kept its words as written, with no pill when nothing is flagged', async () => {
  vi.useFakeTimers()
  const sent = mount(RECOMMENDED_ASKS.twin.stored)
  // No flag: no pill, and each row reads as stored.
  expect(shown()).toEqual(['Go', 'Go (Recommended)'])
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

/** What the card posts for `taps` on a fresh mount of the ask; pick several waits for Send. */
async function posts(ask: BotItemAsk, taps: string[], multi: boolean): Promise<string | undefined> {
  if (tree) {
    act(() => tree!.unmount())
    tree = null
    await queries?.end()
  }
  const sent = mount(ask)
  for (const label of taps) {
    await press(label)
  }
  if (multi) {
    await send()
  }
  return sent[0]?.text
}

it('posts one option and two picks that join into it as different words', async () => {
  vi.useFakeTimers()
  const { delimited } = RECOMMENDED_ASKS
  mount(delimited.stored)
  expect(shown()).toEqual([
    'Audit, (Recommended)',
    'Audit,',
    'Audit [recommended]  Recommended',
    '(Recommended)'
  ])
  // Taps in reverse; the card joins picks in display order.
  expect(await posts(delimited.stored, ['Audit, (Recommended)'], true)).toBe(
    RECOMMENDED_ASK_ANSWERS.delimitedOne
  )
  expect(await posts(delimited.stored, ['(Recommended)', 'Audit [recommended]'], true)).toBe(
    RECOMMENDED_ASK_ANSWERS.delimitedPair
  )
})

it('posts the same two choices apart with the options reordered', async () => {
  vi.useFakeTimers()
  const { delimitedReordered } = RECOMMENDED_ASKS
  expect(await posts(delimitedReordered.stored, ['Audit, (Recommended)'], true)).toBe(
    RECOMMENDED_ASK_ANSWERS.delimitedReorderedOne
  )
  expect(
    await posts(delimitedReordered.stored, ['Audit [recommended]', '(Recommended)'], true)
  ).toBe(RECOMMENDED_ASK_ANSWERS.delimitedReorderedPair)
})

it('shows a label kept for its attached mark as written, with the flag pill only on the flag', async () => {
  vi.useFakeTimers()
  mount(RECOMMENDED_ASKS.attached.stored)
  expect(shown()).toEqual(['Wait  Recommended', 'Go(Recommended) [recommended]'])
  expect(
    await posts(RECOMMENDED_ASKS.attached.stored, ['Go(Recommended) [recommended]'], false)
  ).toBe(RECOMMENDED_ASK_ANSWERS.attached)
})

it('marks only the flagged twin, the kept twin reading as written', async () => {
  vi.useFakeTimers()
  const { twinFlagged } = RECOMMENDED_ASKS
  mount(twinFlagged.stored)
  expect(shown()).toEqual(['Go  Recommended', 'Go (Recommended)'])
  expect(await posts(twinFlagged.stored, ['Go'], false)).toBe(
    RECOMMENDED_ASK_ANSWERS.twinFlaggedPlain
  )
  expect(await posts(twinFlagged.stored, ['Go (Recommended)'], false)).toBe(
    RECOMMENDED_ASK_ANSWERS.twinFlaggedMarked
  )
})

it('reads an attached literal beside its cleaned twin as written, the pill only on the flag', async () => {
  vi.useFakeTimers()
  const { bracketAttached } = RECOMMENDED_ASKS
  mount(bracketAttached.stored)
  expect(shown()).toEqual(['Go  Recommended', 'Go(Recommended)'])
  expect(await posts(bracketAttached.stored, ['Go'], false)).toBe(
    RECOMMENDED_ASK_ANSWERS.bracketAttachedClean
  )
  expect(await posts(bracketAttached.stored, ['Go(Recommended)'], false)).toBe(
    RECOMMENDED_ASK_ANSWERS.bracketAttachedLiteral
  )
})

it('marks only the flagged option beside a label kept for its ", "', async () => {
  vi.useFakeTimers()
  const { commaWait } = RECOMMENDED_ASKS
  mount(commaWait.stored)
  expect(shown()).toEqual(['A, (Recommended)', 'Wait  Recommended'])
  expect(await posts(commaWait.stored, ['A, (Recommended)'], true)).toBe(
    RECOMMENDED_ASK_ANSWERS.commaWaitLiteral
  )
  expect(await posts(commaWait.stored, ['Wait'], true)).toBe(RECOMMENDED_ASK_ANSWERS.commaWaitFlag)
})

it('posts two sets of picks that would join alike as different words', async () => {
  vi.useFakeTimers()
  const { subsets } = RECOMMENDED_ASKS
  mount(subsets.stored)
  expect(shown()).toEqual(['A, B (Recommended)', 'C', 'A', 'B, C'])
  expect(await posts(subsets.stored, ['C', 'A, B (Recommended)'], true)).toBe(
    RECOMMENDED_ASK_ANSWERS.subsetsFirst
  )
  expect(await posts(subsets.stored, ['B, C', 'A'], true)).toBe(
    RECOMMENDED_ASK_ANSWERS.subsetsSecond
  )
})

it('posts the same two sets apart with the options reordered', async () => {
  vi.useFakeTimers()
  const { subsetsReordered } = RECOMMENDED_ASKS
  expect(await posts(subsetsReordered.stored, ['A', 'B, C'], true)).toBe(
    RECOMMENDED_ASK_ANSWERS.subsetsReorderedFirst
  )
  expect(await posts(subsetsReordered.stored, ['A, B (Recommended)', 'C'], true)).toBe(
    RECOMMENDED_ASK_ANSWERS.subsetsReorderedSecond
  )
})

it('steps a spaced label and the two picks it reads like into different answer lines', async () => {
  vi.useFakeTimers()
  const { severalFolded } = RECOMMENDED_ASKS
  const step = async (taps: string[]) => {
    if (tree) {
      act(() => tree!.unmount())
      tree = null
      await queries?.end()
    }
    const sent = mount(severalFolded.stored)
    for (const label of taps) {
      await press(label)
    }
    await act(async () => footer('Next').props.onPress())
    await press('Yes')
    return sent.map((entry) => entry.text)
  }
  expect(await step(['Notify', 'Audit'])).toEqual([RECOMMENDED_ASK_ANSWERS.severalFoldedPair])
  expect(await step(['Audit,  Notify (Recommended)'])).toEqual([
    RECOMMENDED_ASK_ANSWERS.severalFoldedOne
  ])
})

it("still reads an agent prompt's inline mark as its pill: only an item's ask shows labels as written", () => {
  queries = documentQueryClient()
  act(() => {
    tree = create(
      queries!.wrap(
        createElement(MobileNativeChatAsk, {
          prompt: {
            questions: [
              {
                question: 'Indent with?',
                multiSelect: false,
                options: [{ label: 'Tabs (Recommended)' }, { label: 'Spaces' }]
              }
            ]
          },
          onAnswer: async () => true
        })
      )
    )
  })
  expect(shown()).toEqual(['Tabs  Recommended', 'Spaces'])
  // An agent prompt keeps its "Other…" row as before, not an action.
  expect(freeText().props).toMatchObject({ label: 'Other…', action: false })
})

it('steps a label of several lines and its stepped answer apart', async () => {
  vi.useFakeTimers()
  const { multiline } = RECOMMENDED_ASKS
  const sent = mount(multiline.stored)
  expect(shown()).toEqual(['A', 'A\nSecond? → B (Recommended)'])
  await press('A')
  await press('B')
  expect(sent.map((entry) => entry.text)).toEqual([RECOMMENDED_ASK_ANSWERS.multilineStepped])
})

it('tells an authored "Other…" from the card\'s own free-text action before either is chosen', async () => {
  vi.useFakeTimers()
  const { otherAuthored } = RECOMMENDED_ASKS
  mount(otherAuthored.stored)
  // The authored option reads as written with its flag's pill; the action reads as one, with its pencil.
  expect(shown()).toEqual(['Other…  Recommended', 'Wait'])
  expect(rows()[0]!.props.action).toBeFalsy()
  expect(freeText().props).toMatchObject({ label: 'Type your answer', action: true })
  expect(freeText().findAll((node) => isHost(node, 'Pencil'))).toHaveLength(1)
  expect(rows()[0]!.findAll((node) => isHost(node, 'Pencil'))).toHaveLength(0)
  // The authored option posts its words.
  expect(await posts(otherAuthored.stored, ['Other…'], false)).toBe(
    RECOMMENDED_ASK_ANSWERS.otherAuthored
  )
  // On its own mount, the action opens the box for your words and posts nothing.
  act(() => tree!.unmount())
  tree = null
  await queries?.end()
  const sent = mount(otherAuthored.stored)
  act(() => freeText().props.onPress())
  await act(async () => {
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS)
  })
  expect(tree!.root.findAll((node) => isHost(node, 'MessageBox'))).toHaveLength(1)
  expect(sent).toEqual([])
})

it("tells an authored option in the action's very words from the action itself", async () => {
  vi.useFakeTimers()
  const { typeAnswerAuthored } = RECOMMENDED_ASKS
  mount(typeAnswerAuthored.stored)
  // Same words, told apart by what each is: the authored one has no pencil and is not an action.
  expect(shown()).toEqual(['Type your answer', 'Wait  Recommended'])
  expect(rows()[0]!.props.action).toBeFalsy()
  expect(rows()[0]!.findAll((node) => isHost(node, 'Pencil'))).toHaveLength(0)
  expect(freeText().props).toMatchObject({ label: 'Type your answer', action: true })
  expect(freeText().findAll((node) => isHost(node, 'Pencil'))).toHaveLength(1)
  expect(await posts(typeAnswerAuthored.stored, ['Type your answer'], false)).toBe(
    RECOMMENDED_ASK_ANSWERS.typeAnswerAuthored
  )
})
