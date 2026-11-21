import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { BotGroupTurn } from '../../../src/shared/bots/bot-group'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { MobileBotGroupTurn } from './MobileBotGroupTurns'

vi.mock('react-native', () => ({
  Text: 'Text',
  View: 'View',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios' }
}))
vi.mock('lucide-react-native', () => ({ Reply: 'Icon', Square: 'Icon' }))
vi.mock('../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'dark' }))
vi.mock('../i18n/use-mobile-translation', () => ({
  useMobileTranslation:
    () =>
    (_key: string, fallback: string, values: Record<string, string> = {}) =>
      fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values[name] ?? '')
}))
vi.mock('../session/native-chat/visual/MobileNativeChatVisual', () => ({
  useMobileNativeChatVisualRenderer: () => null
}))
vi.mock(
  '../session/native-chat/transcript/projection/use-mobile-native-chat-message-detail',
  () => ({
    useMobileNativeChatMessageDetail: (messages: unknown) => ({ messages, detail: null })
  })
)
vi.mock(
  '../session/native-chat/transcript/message-actions/MobileNativeChatRowOverlaysHost',
  () => ({ MobileNativeChatRowOverlaysHost: ({ children }: { children: unknown }) => children })
)
vi.mock('../session/native-chat/agent-session/use-mobile-structured-agent-session', () => ({
  useMobileStructuredAgentSession: () => null
}))
vi.mock('../session/native-chat/transcript/messages/MobileNativeChatTurnStatus', () => ({
  MobileNativeChatTurnStatus: ({ pendingLabel }: { pendingLabel?: string }) =>
    createElement('Status', { label: pendingLabel })
}))
vi.mock('../session/native-chat/transcript/messages/MobileNativeChatMessage', () => ({
  MobileNativeChatMessage: ({ message }: { message: { blocks: { text: string }[] } }) =>
    createElement('Message', { text: message.blocks[0]?.text })
}))

let tree: ReactTestRenderer | null = null
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
})

const finished: BotGroupTurn = {
  operationId: 'operation-1',
  botId: 'bot-1',
  botName: 'Forge',
  avatar: null,
  agent: 'claude',
  sessionId: 'bot-group-member-1',
  reply: 'Shipped the fix and opened the PR.'
}

// No session rows hold the turn: its member chat's loaded window is newer than it.
function draw(turn: BotGroupTurn) {
  act(() => {
    tree = create(
      createElement(MobileBotGroupTurn, {
        turn,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no session is read; the turn never calls its client.
        client: {} as RpcClient,
        onStop: () => {},
        onReply: () => {}
      })
    )
  })
  const nodes = (type: string) => tree!.root.findAll((node) => node.type === type)
  return {
    label: nodes('Status')[0]?.props.label,
    messages: nodes('Message').map((node) => node.props.text),
    texts: nodes('Text').flatMap((node) => node.props.children),
    stop: nodes('Pressable').some((node) => node.props.accessibilityLabel === 'Stop Forge')
  }
}

it('draws the reply saved when the turn ended when its chat rows are not loaded', () => {
  expect(draw(finished)).toEqual({
    label: 'Replied',
    messages: ['Shipped the fix and opened the PR.'],
    texts: [],
    stop: false
  })
})

it('reads a turn that ended without a reply as ended, with no waiting notice', () => {
  expect(draw({ ...finished, reply: null })).toEqual({
    label: 'Ended',
    messages: [],
    texts: [],
    stop: false
  })
})

it('still waits for a turn with no saved reply and no rows', () => {
  const { reply: _reply, ...running } = finished
  expect(draw(running)).toMatchObject({
    label: 'Waiting for the native session…',
    stop: true
  })
})
