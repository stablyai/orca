import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { RouteBot } from '../../bots/use-route-bot'
import {
  mobileBotOwnsLinkedSession,
  useMobileBotChatIdentity
} from './use-mobile-bot-chat-identity'
import type { MobileNativeChatBotIdentity } from './mobile-native-chat-bot-identity'

const routeBot: RouteBot = {
  bot: {
    id: 'atlas',
    name: 'Atlas',
    folderWorkspaceId: 'home',
    chatSessionId: 'home-session',
    avatar: null,
    agent: 'codex',
    paused: false,
    members: [],
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    slack: null,
    linear: null,
    github: null
  },
  avatar: { kind: 'text', text: 'A' },
  activity: null,
  listStatus: null,
  needsYou: 0,
  applyBot: () => {},
  refresh: () => {},
  reads: 1,
  itemReads: 1,
  hostKey: 'host'
}
function metadata(botId: string | null, sessionId = 'thread') {
  return {
    folderWorkspaces: [
      {
        id: 'home',
        externalConversations: [{ sessionId, bot: botId ? { kind: 'bot', botId } : undefined }]
      }
    ]
  }
}
const sendRequest = vi.fn<RpcClient['sendRequest']>()
const client: RpcClient = {
  sendRequest,
  subscribe: () => () => {},
  updateTerminalSubscriptionViewport: () => {},
  getState: () => 'connected',
  getReconnectAttempt: () => 0,
  getLastConnectedAt: () => null,
  onStateChange: () => () => {},
  notifyForeground: () => {},
  close: () => {}
}
let tree: ReactTestRenderer | null = null
let identity: MobileNativeChatBotIdentity | null = null
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  sendRequest.mockReset()
})
function Harness({ sessionId, bot = routeBot }: { sessionId: string; bot?: RouteBot | null }) {
  identity = useMobileBotChatIdentity(bot, client, 'connected', sessionId)
  return null
}

it('requires the host folder link to name this exact bot and session, retaining legacy fallback', () => {
  expect(mobileBotOwnsLinkedSession(routeBot.bot, 'thread', metadata('atlas'))).toBe(true)
  expect(mobileBotOwnsLinkedSession(routeBot.bot, 'ordinary', metadata('atlas'))).toBe(false)
  expect(mobileBotOwnsLinkedSession(routeBot.bot, 'thread', metadata('other-host-bot'))).toBe(false)
  expect(mobileBotOwnsLinkedSession(routeBot.bot, 'thread', metadata(null))).toBe(false)
  expect(mobileBotOwnsLinkedSession(routeBot.bot, 'thread', {})).toBe(false)
})

it('resolves Home without another read and fences a late external answer after worker navigation', async () => {
  let answer: ((value: Awaited<ReturnType<RpcClient['sendRequest']>>) => void) | undefined
  sendRequest.mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve
      })
  )
  await act(async () => {
    tree = create(createElement(Harness, { sessionId: 'home-session' }))
  })
  expect(identity?.name).toBe('Atlas')
  expect(sendRequest).not.toHaveBeenCalled()
  await act(async () => {
    tree!.update(createElement(Harness, { sessionId: 'thread' }))
  })
  expect(identity).toBeNull()
  const threadAnswer = answer
  await act(async () => {
    tree!.update(createElement(Harness, { sessionId: 'worker' }))
  })
  await act(async () => {
    threadAnswer?.({ id: 'a', ok: true, result: metadata('atlas') })
  })
  expect(identity).toBeNull()
  await act(async () => {
    answer?.({ id: 'b', ok: true, result: metadata('atlas', 'worker') })
  })
  expect(identity?.name).toBe('Atlas')
  await act(async () => {
    tree!.update(createElement(Harness, { sessionId: 'worker', bot: null }))
  })
  expect(identity).toBeNull()
})
