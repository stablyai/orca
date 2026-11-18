import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  NativeChatMessage,
  NativeChatTextBlock
} from '../../../../../src/shared/native-chat/native-chat-types'
import {
  automationResultNoteBody,
  makeAutomationResultNote,
  type AutomationResultNote
} from '../../../../../src/shared/bots/bot-automation-result-note'

// The bot cards read their host and the clipboard; these rows draw none.
vi.mock('./bot-cards/mobile-native-chat-bot-cards', () => ({
  mobileNativeChatBotCard: () => null,
  mobileNativeChatOtherBotCard: () => null
}))
vi.mock('react-native', async () => {
  const React = await import('react')
  const Text = ({ children, ...props }: { children?: ReactNode }): ReactNode =>
    React.createElement('Text', props, children)
  return {
    Image: 'Image',
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Text,
    View: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Animated: { Value: class {}, timing: () => ({ start: vi.fn() }) }
  }
})
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('lucide-react-native', () => ({
  Bot: 'Bot',
  Brain: 'Brain',
  CalendarClock: 'CalendarClock',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight',
  ChevronUp: 'ChevronUp',
  Copy: 'Copy',
  Eye: 'Eye',
  FileMinus2: 'FileMinus2',
  FilePen: 'FilePen',
  FilePlus2: 'FilePlus2',
  Folder: 'Folder',
  Globe: 'Globe',
  Hourglass: 'Hourglass',
  ListChecks: 'ListChecks',
  MessageSquareMore: 'MessageSquareMore',
  Pencil: 'Pencil',
  Play: 'Play',
  Plug: 'Plug',
  Search: 'Search',
  SquareChevronRight: 'SquareChevronRight',
  SquareTerminal: 'SquareTerminal',
  Webhook: 'Webhook',
  Wrench: 'Wrench',
  Zap: 'Zap',
  ArrowUpRight: 'ArrowUpRight',
  Clock: 'Clock'
}))
vi.mock('../../../components/markdown/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))
vi.mock('./message-actions/MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))
vi.mock('../../../hooks/use-now', () => ({
  useNow: () => 70_000,
  useSharedNowSnapshot: <T,>(_intervalMs: number, select: (now: number) => T) => select(70_000)
}))

import { MobileNativeChatMessage } from './messages/MobileNativeChatMessage'

function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('')
}

const NOTE: AutomationResultNote = makeAutomationResultNote({
  automationId: 'auto-1',
  automationName: 'Hook echo',
  botName: 'Atlas',
  runId: 'run-1',
  trigger: 'event',
  outcome: 'finished',
  result: 'got: hello\n\nservice: api',
  at: 1_000
})

function noteMessage(block: Partial<NativeChatTextBlock>): NativeChatMessage {
  const { text, presentation, automationResult } = automationResultNoteBody(NOTE)
  return {
    id: 'note',
    role: 'system',
    blocks: [{ type: 'text', text, presentation, automationResult, ...block }],
    timestamp: null,
    source: 'transcript'
  }
}

describe('mobile automation result note', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(message: NativeChatMessage): ReactTestRenderer {
    act(() => {
      renderer = create(createElement(MobileNativeChatMessage, { message }))
    })
    return renderer!
  }

  const texts = (tree: ReactTestRenderer): string[] =>
    tree.root.findAll((node) => String(node.type) === 'Text').map(textOf)
  const markdown = (tree: ReactTestRenderer): unknown[] =>
    tree.root.findAll((node) => String(node.type) === 'MobileMarkdown').map((n) => n.props.content)

  it('draws a collapsed row that opens into the result and its read caption', () => {
    const tree = render(noteMessage({}))
    expect(markdown(tree)).toEqual([])

    act(() => tree.root.findAll((node) => String(node.type) === 'Pressable')[0]!.props.onPress())

    expect(markdown(tree)).toEqual(['got: hello\n\nservice: api'])
    expect(texts(tree)).toContain("Atlas hasn't read this yet. It goes with your next message.")
  })

  it('says a note a later /clear left unread will never reach the bot', () => {
    const tree = render(noteMessage({ automationResultCleared: true }))
    act(() => tree.root.findAll((node) => String(node.type) === 'Pressable')[0]!.props.onPress())
    expect(texts(tree)).toContain("Arrived before the chat was cleared. It won't go to Atlas.")
  })

  it('draws the plain line an older host or client falls back to without the note', () => {
    const tree = render(noteMessage({ automationResult: undefined }))
    expect(texts(tree)).toEqual(['Hook echo finished: got: hello'])
  })

  it("says how many results the person's message carried", () => {
    const tree = render({
      id: 'user',
      role: 'user',
      blocks: [{ type: 'text', text: 'what came in?' }],
      timestamp: null,
      source: 'transcript',
      automationResultsCarried: 2
    })
    expect(texts(tree)).toContain('Sent with 2 automation results')
  })
})
