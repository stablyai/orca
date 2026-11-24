import { afterEach, expect, it, vi } from 'vitest'

const { postConnectorAction } = vi.hoisted(() => ({ postConnectorAction: vi.fn() }))
vi.mock('../bots/bot-session-tabs', () => ({
  botOfSession: () => ({ id: 'bot-1', name: 'Reviewer' })
}))
// Whom a turn acts for is not this gate's question; read for real it needs the orchestration db.
vi.mock('../bots/bot-turn-for', () => ({ botTurnFor: async () => undefined }))
vi.mock('../connector-cloud/connector-actions', () => ({ postConnectorAction }))
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { chatPaneKey, runtimeChatHost } from './external-conversation-chat'
import type { ExternalConversationLinkStore } from './external-conversation-links'
import { ExternalConversationSeam } from './external-conversation-seam'
import type { DeliveryReceipts } from './external-conversation-delivery-receipts'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { CONNECTOR_METHODS } from '../runtime/rpc/methods/connectors/connector'
import { CONNECTOR_ACT_METHOD } from '../runtime/rpc/methods/connector-act'
import { CONNECTOR_REACT_METHOD } from '../runtime/rpc/methods/connector-react'
import type { AutomationRunMessage } from '../../shared/automations/automation-run-message'
import {
  createBotAutomationDispatcher,
  type BotAutomationSessions,
  type BotRunResults
} from '../automations/bot-automation-launch'
import type { BotRunFields } from '../bots/bot-chat-session'

const thread = { source: 'slack' as const, externalId: 'T0TEAM:C0CHANNEL:1.0:U0BOT' }
const link: ExternalConversationLink = {
  ...thread,
  sessionId: 'chat-1',
  agent: 'claude',
  paneKey: chatPaneKey('chat-1'),
  bot: { kind: 'bot', botId: 'bot-1' },
  createdAt: 0
}

const opener = (body: AgentJournalRenderItem['body']): AgentJournalRenderItem => ({
  itemId: 'opener',
  revision: 0,
  sequence: 1,
  observedAt: 1,
  body
})

// The thread's own message opened the turn: its delivery stamp names this conversation.
const threadMessage = opener({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Can you check the build?' }],
  origin: 'connector',
  connectorDelivery: { account: 'acct', conversation: thread, deliveryId: 'd1' }
})

// Item mail woke the same chat later: not a report finishing the thread's ask.
const itemMail = opener({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'You have 1 orchestration message.' }],
  from: {
    kind: 'agent',
    senders: [
      {
        party: { address: 'session:item-owner', terminalHandle: null, orcaSessionId: null },
        name: null
      }
    ],
    orchestration: {
      message: 'mail-notice',
      mailbox: 'session:chat-1',
      dispatchId: null,
      messages: [{ messageId: 'm1', runId: 'r1', from: 'session:item-owner' }]
    }
  }
})

// A worker the thread's turn started reports back: that finishes the thread's ask, so it answers there.
const threadWorkerReport = opener({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'You have 1 orchestration message.' }],
  from: {
    kind: 'agent',
    senders: [
      {
        party: { address: 'dispatch:d1', terminalHandle: null, orcaSessionId: null },
        name: null,
        relation: 'worker',
        toConversation: true
      }
    ],
    orchestration: {
      message: 'mail-notice',
      mailbox: 'run:r1',
      dispatchId: null,
      messages: [{ messageId: 'm2', runId: 'r1', from: 'dispatch:d1' }]
    }
  }
})

// A later message from the thread, queued behind a turn, from a cloud without the reply outbox (or
// after a restart): no delivery stamp, but the message names the conversation it came from.
const queuedThreadMessage = opener({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'And the logs too?' }],
  origin: 'connector',
  connectorConversation: thread
})

const runMessage = (automationRun: AutomationRunMessage) =>
  opener({
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Review the new commits.' }],
    origin: 'automation-run',
    automationRun
  })

/** The message an event automation that answers in its thread sends into the chat owning that thread. */
async function ownerRouteRunMessage(): Promise<AutomationRunMessage> {
  const sent: BotRunFields[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an owner-route run only sends into the owning session.
  const sessions = {
    sendToSession: async (_bot, sessionId, _text, run) => {
      sent.push(run!)
      return { sessionId, messageId: 'm1' }
    }
  } as unknown as BotAutomationSessions
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the run's turn never ends here.
  const results = {
    watch: async () => ({ next: () => new Promise(() => {}), dispose: () => {} })
  } as unknown as BotRunResults
  const launch = createBotAutomationDispatcher(sessions, results, {
    adopt: () => false,
    ownerChat: async () => ({
      worktreeId: 'folder:folder-1',
      sessionId: link.sessionId,
      agent: 'claude',
      bot: link.bot
    })
  })
  const event = {
    triggerId: 't1',
    source: 'github' as const,
    event: 'pr_review',
    key: 'k1',
    occurredAt: 1,
    conversation: { source: 'github' as const, externalId: 'gh:new' },
    threadOwner: { conversation: thread, actsFor: null }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reads only these automation, run and target fields.
  await launch({
    automation: {
      id: 'a1',
      name: 'Review PRs',
      prompt: 'Review the new commits.',
      bot: { botId: 'bot-1', resultsTo: 'thread' }
    },
    run: { id: 'run-1', trigger: 'event', event, title: 'PR review' },
    target: {
      bot: { id: 'bot-1', agent: 'claude', members: [] },
      workspaceId: 'folder-1',
      runsIn: 'new'
    }
  } as unknown as Parameters<typeof launch>[0])
  return sent[0]!.automationRun!
}

/** One linked chat on one watched seam; each turn swaps the running turn's opener. */
function linkedChat() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: link lookups read only these.
  const store = {
    getRepos: () => [],
    getAllWorktreeMeta: () => ({}),
    getFolderWorkspaces: () => [{ id: 'folder-1', externalConversations: [link] }]
  } as unknown as ExternalConversationLinkStore
  let active = threadMessage
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a reply reads only the running turn and its opener.
  const chat = {
    publishedWork: () => ({
      activeTurnOpener: active,
      activeTurn: { item: { ...active, itemId: 'turn', body: { kind: 'turn-lifecycle' } } },
      actionablePrompts: []
    }),
    subscribeTurnCompletions: () => () => {}
  } as unknown as StructuredAgentSessionHost
  setStructuredAgentSessionHost(chat)
  const seam = new ExternalConversationSeam({
    store,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no delivery runs here.
    receipts: {} as DeliveryReceipts,
    onWorkspaceRemoved: () => () => {},
    readHookRow: () => null,
    onAgentPaneChange: () => () => {}
  })
  const runtime = { ensureStructuredAgentSessionHost: async () => {} }
  seam.watch({ chat: runtimeChatHost(runtime) }, () => {})
  const reply = vi.fn(async () => ({ ok: true as const, value: { status: 'posted' as const } }))
  const method = CONNECTOR_METHODS.find((entry) => entry.name === 'connector.reply')!
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connector.reply reads only these runtime fields.
  const context = {
    runtime: {
      ...runtime,
      getExternalConversationSeam: () => seam,
      bots: { enabled: () => true, list: () => [{ id: 'bot-1', folderWorkspaceId: 'folder-1' }] },
      lookAround: { botOfTidyUp: () => null, botOfLook: () => null },
      getConnectorCloud: () => ({
        cloudFeatures: () => new Set(['actions']),
        status: () => 'ready',
        reply
      })
    }
  } as unknown as Parameters<typeof method.handler>[1]
  const outcome = (sent: Promise<unknown>) =>
    sent.then(
      () => 'posted',
      (error: { code?: string; message?: string }) => error.code ?? error.message
    )
  const replyIn = (turnOpener: AgentJournalRenderItem) => {
    active = turnOpener
    reply.mockClear()
    return outcome(
      method.handler(
        { sessionId: link.sessionId, replyId: 'r1', text: 'Screenshots attached.' },
        context
      )
    )
  }
  // `--file` and `--choice` go as connector.act's reply verb; `--react` as connector.react.
  const actIn = (turnOpener: AgentJournalRenderItem) => {
    active = turnOpener
    postConnectorAction.mockClear()
    return outcome(
      CONNECTOR_ACT_METHOD.handler(
        { sessionId: link.sessionId, verb: 'reply', args: { text: 'Files', postId: 'p1' } },
        context
      )
    )
  }
  const reactIn = (turnOpener: AgentJournalRenderItem) => {
    active = turnOpener
    return outcome(
      CONNECTOR_REACT_METHOD.handler({ sessionId: link.sessionId, emoji: 'eyes' }, context)
    )
  }
  return { replyIn, actIn, reactIn, reply }
}

afterEach(() => setStructuredAgentSessionHost(null))

it('posts an agent reply to the thread only on a turn the thread owns, not one mail woke', async () => {
  postConnectorAction.mockResolvedValue({ ok: true, value: { ok: true, result: {} } })
  const { replyIn, actIn, reactIn, reply } = linkedChat()
  expect(await replyIn(threadMessage)).toBe('posted')
  expect(reply).toHaveBeenCalledWith(
    expect.objectContaining({ conversation: expect.objectContaining({ source: 'slack' }) })
  )
  expect(await actIn(threadMessage)).toBe('posted')
  expect(postConnectorAction).toHaveBeenCalledTimes(1)

  // Next turn in the same chat, still linked to the thread: item mail woke it, so nothing goes to Slack.
  expect(await replyIn(itemMail)).toBe('turn_stays_in_orca')
  expect(reply).not.toHaveBeenCalled()
  expect(await actIn(itemMail)).toBe('turn_stays_in_orca')
  expect(postConnectorAction).not.toHaveBeenCalled()
  expect(await reactIn(itemMail)).toBe('turn_stays_in_orca')

  expect(await replyIn(threadWorkerReport)).toBe('posted')
  expect(await replyIn(queuedThreadMessage)).toBe('posted')

  // An event run sent into the chat owning its thread answers there; the same run marked for no
  // thread (as a run that took its own conversation, or went to the Chat) does not.
  const ownerRun = await ownerRouteRunMessage()
  expect(ownerRun.answersThread).toBe(true)
  expect(await replyIn(runMessage(ownerRun))).toBe('posted')
  const { answersThread: _dropped, ...unrouted } = ownerRun
  expect(await replyIn(runMessage(unrouted))).toBe('turn_stays_in_orca')
})
