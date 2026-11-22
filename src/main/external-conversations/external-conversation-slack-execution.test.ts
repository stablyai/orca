import { writeOwnerOnlyFileDurable } from '../filesystem/owner-only-durable-file-write'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { ConnectorDelivery } from '../../shared/connectors/connector-cloud-contract'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { createSlackRequesterMemory } from '../bots/slack-requester-memory'
import { botChatFor, routeBotChat, type ConversationBots } from './external-conversation-bots'
import { answerConversation } from './external-conversation-answer'
import { deliverToChat } from './external-conversation-chat-admission'
import type { ConversationChat } from './external-conversation-chat'
import { ChatDeliveries } from './external-conversation-chat-delivery'
import { GoneChats } from './external-conversation-gone-chats'
import { writeChatLink } from './external-conversation-link-writes'
import { findLink, type ExternalConversationLinkStore } from './external-conversation-links'
import { legacyTurnWords } from './external-conversation-turn-ends'
import type { ConnectorMessage } from './external-conversation-types'

const key = { source: 'slack' as const, externalId: 'T1:C1:100.001' }
const bot = { kind: 'bot-chat' as const, botId: 'bot' }
const worktreeId = folderWorkspaceKey('bot-home')
const reply = { account: 'account' }

function message(userId: string, stamped = true) {
  const parsed = ConnectorDelivery.parse({
    kind: 'send',
    deliveryId: userId,
    expiresAt: 1,
    conversation: key,
    text: 'Use my preferences',
    asker: {
      userId,
      role: 'owner',
      place: { kind: 'public_channel', id: 'C1' },
      text: 'Use my preferences',
      context: [],
      ...(stamped ? { slackRequester: { teamId: 'T1', userId } } : {})
    }
  })
  if (parsed.kind !== 'send' || !parsed.asker) {
    throw new Error('Expected a send with an asker')
  }
  return { text: parsed.text, asker: parsed.asker, reply, deliveryId: parsed.deliveryId }
}

it('keeps the Slack reply link and memory with its execution until that work finishes', async ({
  onTestFinished
}) => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-slack-execution-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const memory = createSlackRequesterMemory(dir, writeOwnerOnlyFileDurable)
  let links: ExternalConversationLink[] = []
  const record = () => ({ id: 'bot-home', externalConversations: links })
  const store: ExternalConversationLinkStore = {
    getAllWorktreeMeta: () => ({}),
    getFolderWorkspaces: () => [record()],
    getFolderWorkspace: record,
    updateFolderWorkspace: (_id, updates) => {
      links = updates.externalConversations
    },
    getRepos: () => [],
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: () => {}
  }
  writeChatLink(store, key, { agent: 'codex', bot, worktreeId, sessionId: 'legacy' })
  const opened: {
    sessionId: string
    requester: unknown
    memory: ReturnType<typeof memory.bind>
  }[] = []
  let active = true
  let repliesSettled = true
  let workStartsDuringOpen = false
  const bots: ConversationBots = {
    refusal: () => null,
    hasSlackWorkspace: (_botId, teamId) => teamId === 'T1',
    open: async () => ({ agent: 'codex', worktreeId, sessionId: 'legacy' }),
    workLinks: async () => [],
    openSlackExecution:
      () =>
      async ({ requester, sessionId }) => {
        opened.push({
          sessionId,
          requester,
          memory: memory.bind(requester && { botId: 'bot', ...requester })
        })
        active ||= workStartsDuringOpen
        return { agent: 'codex', worktreeId, sessionId }
      }
  }
  const conversationChat = {
    ...admissionHost(() => {}),
    currentWorkAtRest: async () => ({
      working: () => active,
      owesAnySend: () => false,
      hasActionablePrompt: () => false
    })
  }
  const chatHost = {
    current: () => conversationChat,
    ensure: async () => conversationChat,
    onChanged: () => () => {}
  }
  const routeBot = routeBotChat({ store, repliesSettled: async () => repliesSettled }, () => false)
  const route = (request: ConnectorMessage & { deliveryId: string }) =>
    routeBot({ bots, chat: chatHost }, key, bot, request)

  expect(
    await botChatFor(store, { ...bots, openSlackExecution: undefined }, key, bot)
  ).toMatchObject({ sessionId: 'legacy' })
  const { reply: _reply, ...withoutOutbox } = message('U1')
  active = false
  expect(await route(withoutOutbox)).toEqual({
    outcome: 'refused',
    reason: 'agent_not_reachable'
  })
  expect(opened).toEqual([])
  expect(await route(message('U1'))).toEqual({
    outcome: 'refused',
    reason: 'delivery_backlog_full'
  })
  expect(findLink(store, key)?.link.sessionId).toBe('legacy')
  links = []
  const first = await route(message('U1'))
  if ('outcome' in first) {
    throw new Error('Expected a fresh chat')
  }
  writeChatLink(store, key, first)
  const firstMemory = opened[0]!.memory
  await firstMemory.remember('First requester preference', '2026-11-22')
  expect(findLink(store, key)?.link.isolatedSlack).toBe(true)
  expect(await new GoneChats({ store, released: () => {} }).linkedChatOf({}, key)).toBeNull()
  expect(
    await answerConversation({ bots }, { store, events: null }, key, {
      promptId: 'private-turn-prompt',
      optionId: 'continue',
      signal: new AbortController().signal
    })
  ).toEqual({ outcome: 'refused', reason: 'prompt_unsupported' })
  expect(await botChatFor(store, { ...bots, openSlackExecution: undefined }, key, bot)).toEqual({
    outcome: 'refused',
    reason: 'agent_not_reachable'
  })
  expect(() =>
    writeChatLink(store, key, { agent: 'codex', bot, worktreeId, sessionId: 'automation' })
  ).toThrow()
  active = true
  expect(await route(message('U2'))).toMatchObject({ outcome: 'refused' })
  expect(findLink(store, key)?.link.sessionId).toBe(first.sessionId)
  active = false
  repliesSettled = false
  expect(await route(message('U2'))).toMatchObject({
    outcome: 'refused',
    reason: 'delivery_backlog_full'
  })
  expect(findLink(store, key)?.link.sessionId).toBe(first.sessionId)
  repliesSettled = true
  const second = await route(message('U2'))
  if ('outcome' in second) {
    throw new Error('Expected a fresh chat')
  }
  writeChatLink(store, key, second)
  const secondMemory = opened[1]!.memory
  await secondMemory.remember('Second requester preference', '2026-11-22')
  expect(await secondMemory.forget('First requester preference')).toBe(false)
  expect((await firstMemory.read()).index).toBe('- 2026-11-22 First requester preference\n')
  expect((await secondMemory.read()).index).toBe('- 2026-11-22 Second requester preference\n')
  const unstamped = await route(message('U1', false))
  expect(unstamped).toMatchObject({ bot: { kind: 'bot' } })
  const ambiguous = await route({ ...message('U1'), later: [message('U2')] })
  expect(ambiguous).toMatchObject({ bot: { kind: 'bot' } })
  expect(await opened[3]!.memory.read()).toEqual({ index: null, topics: [] })
  if ('outcome' in ambiguous) {
    throw new Error('Expected an isolated chat without memory')
  }
  const deliveries = new ChatDeliveries((key, chat) => {
    writeChatLink(store, key, chat)
  })
  const host = admissionHost(() => {
    throw new Error('A send must not survive a stale thread binding')
  })
  writeChatLink(store, key, ambiguous)
  if ('outcome' in unstamped) {
    throw new Error('Expected a fresh chat')
  }
  expect(
    await deliveries.deliver(
      { ensure: async () => host, current: () => host, onChanged: () => () => {} },
      key,
      unstamped,
      { ...message('U1', false), deliveryId: 'stale', signal: new AbortController().signal }
    )
  ).toEqual({ outcome: 'refused', reason: 'delivery_backlog_full' })
  workStartsDuringOpen = true
  expect(await route(message('U1'))).toMatchObject({ outcome: 'refused' })
  expect(findLink(store, key)?.link).toMatchObject({
    source: 'slack',
    externalId: 'T1:C1:100.001',
    sessionId: ambiguous.sessionId
  })
  expect(new Set(['legacy', ...opened.map(({ sessionId }) => sessionId)]).size).toBe(6)
  expect(opened.map(({ requester }) => requester)).toEqual([
    { teamId: 'T1', userId: 'U1' },
    { teamId: 'T1', userId: 'U2' },
    null,
    null,
    { teamId: 'T1', userId: 'U1' }
  ])
})

function admissionHost(
  send: (request: Parameters<ConversationChat['send']>[1]) => void
): ConversationChat {
  return {
    deps: { store: { getConversation: () => ({ currentFence: 1 }) } },
    conversation: async () => {
      throw new Error('Unexpected conversation lookup')
    },
    currentWork: async () => null,
    publishedWork: () => undefined,
    subscribeTurnCompletions: () => () => {},
    waitForSendSettlement: async () => undefined,
    journalReads: async () => {
      throw new Error('Unexpected journal read')
    },
    respondToPrompt: async () => {
      throw new Error('Unexpected response')
    },
    cancel: async () => {
      throw new Error('Unexpected cancel')
    },
    send: async (_caller, request) => {
      await request.beforeRun?.()
      send(request)
      return {
        ok: true,
        fence: 1,
        cursor: { epoch: 'e', sequence: 1 },
        replayed: false,
        value: {
          clientMessageId: 'message',
          queued: { messageId: 'message', position: 0, state: 'waiting' }
        }
      }
    }
  }
}

it('admits isolated input without steering and keeps the original Slack reply destination', async () => {
  const link: ExternalConversationLink = {
    ...key,
    bot: { kind: 'bot', botId: 'bot' },
    isolatedSlack: true,
    paneKey: 'new-pane',
    sessionId: 'fresh-session',
    agent: 'codex',
    createdAt: 1
  }
  let admitted: AgentJournalMessageItem | undefined
  let steered: AgentJournalMessageItem | undefined
  const chat = admissionHost((request) => {
    if (request.delivery === 'queue-if-active') {
      admitted = request.body
    } else {
      steered = request.body
    }
  })
  expect(
    await deliverToChat(chat, link, {
      ...message('U2'),
      signal: new AbortController().signal,
      reply: { account: 'account' },
      deliveryId: 'notified-delivery'
    })
  ).toEqual({ outcome: 'accepted' })
  expect(steered).toBeUndefined()
  expect(admitted?.connectorDelivery).toEqual({
    account: 'account',
    conversation: { source: 'slack', externalId: 'T1:C1:100.001' },
    deliveryId: 'notified-delivery'
  })
  expect(admitted?.asker?.slackRequester).toEqual({ teamId: 'T1', userId: 'U2' })
  expect(
    legacyTurnWords({ lastAssistantMessage: 'Private reply' }, link, 'not-covered', 'Private reply')
  ).toBeNull()
})
