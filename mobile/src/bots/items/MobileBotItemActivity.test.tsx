import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'

vi.mock('react-native', async () => {
  const React = await import('react')
  const { reactNativeMotionStub } = await import('../../test-support/react-native-motion-stub')
  const host =
    (name: string) =>
    ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement(name, props, children)
  return {
    ...reactNativeMotionStub(),
    Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
    Appearance: { getColorScheme: () => 'dark', addChangeListener: () => ({ remove() {} }) },
    useColorScheme: () => 'dark',
    Pressable: host('Pressable'),
    Text: host('Text'),
    View: host('View'),
    StyleSheet: {
      create: (styles: unknown) => styles,
      hairlineWidth: 1,
      flatten: (s: unknown) => s
    }
  }
})
vi.mock('lucide-react-native', () =>
  Object.fromEntries(
    [
      'AlarmClock',
      'AlarmClockOff',
      'Check',
      'ChevronDown',
      'CircleCheck',
      'CircleX',
      'CornerDownRight',
      'Link',
      'Pencil',
      'Play',
      'Plus'
    ].map((name) => [name, name])
  )
)
vi.mock('../../components/markdown/MobileMarkdown', () => ({
  MobileMarkdown: ({ content }: { content: string }) => createElement('Text', null, content)
}))
vi.mock('./MobileBotItemStatusIcon', () => ({ MobileBotItemStatusIcon: () => null }))

import type { BotItemEvent } from '../../../../src/shared/bots/bot-items'
import { makeTestBotItem } from '../../../../src/shared/bots/bot-item.test-fixture'
import { MobileBotItemActivity } from './MobileBotItemActivity'

const ASKER = { kind: 'bot', botId: 'bot-a', chatId: 'chat-home' } as const
const OWNER = { kind: 'owner' } as const

function texts(events: BotItemEvent[]): string[] {
  let tree: ReactTestRenderer | null = null
  act(() => {
    tree = create(
      createElement(MobileBotItemActivity, { item: makeTestBotItem(6), events, onReply: () => {} })
    )
  })
  return tree!.root
    .findAll((node) => String(node.type) === 'Text')
    .map((node) => [node.props.children].flat().join(''))
}

it("quotes a recorded answer's question where the move it caused would have been", () => {
  const shown = texts([
    {
      id: 'e2',
      kind: 'commented',
      actor: ASKER,
      data: { text: 'Retry it here?\n\nOr by hand.' },
      at: 200
    },
    { id: 'e3', kind: 'status', actor: ASKER, data: { from: 'working', to: 'needs_you' }, at: 200 },
    { id: 'e4', kind: 'commented', actor: OWNER, data: { text: 'Retry.', answers: 'e2' }, at: 250 },
    {
      id: 'e5',
      kind: 'status',
      actor: OWNER,
      data: { from: 'needs_you', to: 'working', cause: 'answer' },
      at: 250
    }
  ])

  expect(shown).toContain('Retry it here?')
  expect(shown).toContain('Answered')
})
