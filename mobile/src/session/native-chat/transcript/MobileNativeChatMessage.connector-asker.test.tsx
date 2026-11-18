import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectorMessageAsker } from '../../../../../src/shared/connector-message-asker'
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
  Goal: 'Goal',
  Clock: 'Clock',
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
  Zap: 'Zap'
}))
vi.mock('../../../components/markdown/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))
vi.mock('./message-actions/MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))
vi.mock('../../../hooks/use-now', () => ({
  useNow: () => 70_000,
  useSharedNowSnapshot: <T,>(_intervalMs: number, select: (now: number) => T) => select(70_000)
}))

vi.mock('react-native-svg', () => ({ default: 'Svg', Path: 'Path' }))
const openExternalLink = vi.hoisted(() => vi.fn())
vi.mock('../../../platform/external-links/external-link', () => ({ openExternalLink }))

import { MobileNativeChatMessage } from './messages/MobileNativeChatMessage'
import {
  MobileNativeChatConnectorAskerTag,
  MobileNativeChatConnectorNoAccessNote,
  MobileNativeChatSentAsGoal
} from './messages/MobileNativeChatUserMessageMarks'

function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('')
}

const SAM: ConnectorMessageAsker = {
  source: 'slack',
  userId: 'U0SAM',
  name: 'Sam Lee',
  role: 'member',
  place: { kind: 'public_channel', id: 'C9' },
  url: 'https://app.slack.com/client/T1/C9/thread/C9-1.2'
}

function userMessage(fields: Partial<NativeChatMessage>): NativeChatMessage {
  return {
    id: 'm1',
    role: 'user',
    blocks: [{ type: 'text', text: 'why is the bot quiet?' }],
    timestamp: null,
    source: 'transcript',
    ...fields
  }
}

describe('mobile chat message indicators', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    openExternalLink.mockReset()
  })

  function render(message: NativeChatMessage): ReactTestRenderer {
    act(() => {
      renderer = create(createElement(MobileNativeChatMessage, { message }))
    })
    return renderer!
  }

  const labelled = (tree: ReactTestRenderer, label: string): ReactTestInstance[] =>
    tree.root.findAll(
      (node) => typeof node.type === 'string' && node.props.accessibilityLabel === label
    )
  const texts = (tree: ReactTestRenderer): string[] =>
    tree.root.findAll((node) => String(node.type) === 'Text').map(textOf)

  it('tags a Slack message with who asked and where, and opens the thread', () => {
    const tree = render(userMessage({ asker: SAM }))
    const [tag] = labelled(tree, 'Sam Lee in Slack. Open in Slack')
    expect(tag).toBeDefined()
    expect(textOf(tag!)).toBe('SLSam Lee·Slack')
    act(() => tag!.props.onPress())
    expect(openExternalLink).toHaveBeenCalledWith(SAM.url)
  })

  it('reads "You" for the owner, as plain text without a link', () => {
    const tree = render(
      userMessage({
        asker: {
          ...SAM,
          role: 'owner',
          place: { kind: 'direct_message', id: 'D1' },
          url: undefined
        }
      })
    )
    const [tag] = labelled(tree, 'You in Slack DM')
    expect(String(tag?.type)).toBe('View')
    expect(textOf(tag!)).toBe('You·Slack DM')
  })

  it('folds the lines from people without access under one note', () => {
    const tree = render(
      userMessage({ asker: { ...SAM, noAccess: [{ name: 'Alex Kim', text: 'Only on main.' }] } })
    )
    expect(texts(tree)).toContain('1 earlier message in the thread')
    expect(texts(tree)).not.toContain('Only on main.')
    const [toggle] = tree.root.findAll(
      (node) => String(node.type) === 'Pressable' && node.props.accessibilityState !== undefined
    )
    act(() => toggle!.props.onPress())
    expect(texts(tree)).toContain('Only on main.')
    expect(labelled(tree, 'Alex Kim · Slack · no access')).toHaveLength(1)
  })

  it('says a message went as a goal', () => {
    expect(texts(render(userMessage({ sentAs: 'goal' })))).toContain('Sent as goal')
  })

  // Each mark subscribes to the theme and language, so a row without one must not mount it.
  it('mounts no mark on a plain row, and no fold on a tagged row without no-access lines', () => {
    const mounted = (tree: ReactTestRenderer, type: unknown): number =>
      tree.root.findAll((node) => node.type === type).length
    const plain = render(userMessage({}))
    expect(mounted(plain, MobileNativeChatConnectorAskerTag)).toBe(0)
    expect(mounted(plain, MobileNativeChatConnectorNoAccessNote)).toBe(0)
    expect(mounted(plain, MobileNativeChatSentAsGoal)).toBe(0)
    act(() => plain.unmount())
    const tagged = render(userMessage({ asker: SAM }))
    expect(mounted(tagged, MobileNativeChatConnectorAskerTag)).toBe(1)
    expect(mounted(tagged, MobileNativeChatConnectorNoAccessNote)).toBe(0)
  })
})
