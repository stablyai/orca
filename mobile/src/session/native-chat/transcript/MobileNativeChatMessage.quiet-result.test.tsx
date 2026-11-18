import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'

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
import { MobileNativeChatBotIdentityContext } from '../mobile-native-chat-bot-identity'
import { MobileNativeChatAutomationTurnContext } from './message-content/MobileNativeChatAnswerProse'

function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('')
}

const BOT = { botId: 'b1', name: 'Scout', avatar: { kind: 'initials', initials: 'S' } }

function answer(text: string): NativeChatMessage {
  return {
    id: 'answer',
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: null,
    source: 'transcript'
  }
}

describe('a bot’s quiet result on the phone', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(
    text: string,
    { botChat = true, inAutomationTurn = false } = {}
  ): { markdown: unknown[]; texts: string[] } {
    act(() => {
      renderer = create(
        createElement(
          MobileNativeChatBotIdentityContext.Provider,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row reads only the bot id.
          { value: botChat ? (BOT as never) : null },
          createElement(
            MobileNativeChatAutomationTurnContext.Provider,
            { value: inAutomationTurn },
            createElement(MobileNativeChatMessage, { message: answer(text) })
          )
        )
      )
    })
    const root = renderer!.root
    return {
      markdown: root
        .findAll((node) => String(node.type) === 'MobileMarkdown')
        .map((node) => node.props.content),
      texts: root.findAll((node) => String(node.type) === 'Text').map(textOf)
    }
  }

  it('reads Nothing to report instead of a message that is only the marker', () => {
    const row = render('**NO_REPLY**')
    expect(row.markdown).toEqual([])
    expect(row.texts).toContain('Nothing to report')
  })

  it('keeps what came before the marker, then reads Nothing to report', () => {
    const row = render('Checked the queue.\n\nNO_REPLY')
    expect(row.markdown).toEqual(['Checked the queue.'])
    expect(row.texts).toContain('Nothing to report')
  })

  it('drops only the marker in a turn an automation’s row opened', () => {
    const row = render('Checked the queue. NO_REPLY', { inAutomationTurn: true })
    expect(row.markdown).toEqual(['Checked the queue.'])
    expect(row.texts).not.toContain('Nothing to report')
  })

  it('leaves the words alone outside a bot’s chat', () => {
    const row = render('NO_REPLY', { botChat: false })
    expect(row.markdown).toEqual(['NO_REPLY'])
    expect(row.texts).not.toContain('Nothing to report')
  })
})
