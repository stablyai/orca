import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { BotChatTreeChat } from '../../../src/shared/bots/bot-chat-tree'

vi.mock('react-native', () => ({ Pressable: 'Pressable', Text: 'Text', View: 'View' }))
vi.mock('lucide-react-native', () => ({ ChevronDown: 'Icon', CircleX: 'Icon' }))
vi.mock('../agents/presentation/AgentStateDot', () => ({
  AGENT_ATTENTION_COLOR: '#000',
  AgentStateDot: 'Dot'
}))
vi.mock('../components/list/DisclosureChevron', () => ({ DisclosureChevron: 'Chevron' }))
vi.mock('../components/controls/MobileSearchField', () => ({ MobileSearchField: 'Search' }))
vi.mock('../components/list/ListGroup', () => ({
  ListGroup: 'ListGroup',
  ListRow: 'ListRow',
  SectionHeader: 'SectionHeader'
}))
vi.mock('../hooks/use-now', () => ({ useNow: () => 0 }))
vi.mock('../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string) => fallback
}))
vi.mock('../theme/mobile-theme', () => ({
  colors: new Proxy({}, { get: () => '#000' }),
  spacing: new Proxy({}, { get: () => 4 })
}))
vi.mock('../theme/themed-styles', () => ({ themedStyleSheet: (make: () => unknown) => make() }))
vi.mock('../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'dark' }))
vi.mock('../worktree/agent-lineage/agent-row-display', () => ({ formatTimeAgo: () => '' }))
vi.mock('./bot-chat-fold-store', () => ({
  setBotChatFold: () => {},
  useBotChatFold: () => undefined
}))
vi.mock('./MobileBotTextButton', () => ({ MobileBotTextButton: 'TextButton' }))
vi.mock('./MobileBotChatLeading', () => ({
  ChatLeading: 'Leading',
  useMobileBotChatLabel: () => ''
}))
vi.mock('./MobileBotChatSearchNotes', () => ({ MobileBotChatSearchNotes: () => null }))

import { MobileBotChatTree } from './MobileBotChatTree'

let renderer: ReactTestRenderer | null = null

function isChat(value: unknown): value is BotChatTreeChat {
  return typeof value === 'object' && value !== null && 'chatId' in value && 'running' in value
}
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

const chat = (chatId: string, patch: Partial<BotChatTreeChat> = {}): BotChatTreeChat => ({
  chatId,
  title: chatId,
  origin: 'side',
  live: 'idle',
  lastActiveAt: 0,
  unread: false,
  closed: false,
  running: [],
  runningTotal: 0,
  finished: [],
  finishedTotal: 0,
  failedTotal: 0,
  ...patch
})

it("lists a group room session's workers under Home Chat, not the room session itself", () => {
  const chats = [
    chat('home', { origin: 'home' }),
    chat('bot-group-member-1', {
      title: 'Claude Chat',
      running: [{ key: 'w1', title: 'w1', state: 'needs-you', startedAt: 0 }],
      runningTotal: 1
    })
  ]
  act(() => {
    renderer = create(
      createElement(MobileBotChatTree, {
        bot: { id: 'b1', name: 'Bo' },
        hostKey: 'local',
        chats,
        loadMore: () => {},
        search: () => Promise.resolve('unsupported' as const),
        actions: { openChat: () => {}, openWorker: () => {} }
      })
    )
  })
  // Each chat group the list renders, by the chat it was given.
  const listed = renderer!.root
    .findAll((node) => typeof node.type === 'function' && 'matches' in node.props)
    .flatMap((node): BotChatTreeChat[] => {
      const shown: unknown = node.props.chat
      return isChat(shown) ? [shown] : []
    })
  expect(listed.map((entry) => entry.chatId)).toEqual(['home'])
  expect(listed[0]!.running.map((worker) => worker.key)).toEqual(['w1'])
})
