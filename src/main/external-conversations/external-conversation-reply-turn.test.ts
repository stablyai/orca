import { afterEach, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { chatPaneKey, runtimeChatHost } from './external-conversation-chat'
import type { ExternalConversationLinkStore } from './external-conversation-links'
import { ExternalConversationSeam } from './external-conversation-seam'
import type { DeliveryReceipts } from './external-conversation-delivery-receipts'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { CONNECTOR_METHODS } from '../runtime/rpc/methods/connectors/connector'

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
      getConnectorCloud: () => ({ cloudFeatures: () => new Set(), reply })
    }
  } as unknown as Parameters<typeof method.handler>[1]
  const replyIn = (opener: AgentJournalRenderItem) => {
    active = opener
    reply.mockClear()
    return method
      .handler({ sessionId: link.sessionId, replyId: 'r1', text: 'Screenshots attached.' }, context)
      .then(
        () => 'posted',
        (error: { code?: string; message?: string }) => error.code ?? error.message
      )
  }
  return { replyIn, reply }
}

afterEach(() => setStructuredAgentSessionHost(null))

it('posts an agent reply to the thread only on a turn the thread owns, not one mail woke', async () => {
  const { replyIn, reply } = linkedChat()
  expect(await replyIn(threadMessage)).toBe('posted')
  expect(reply).toHaveBeenCalledWith(
    expect.objectContaining({ conversation: expect.objectContaining({ source: 'slack' }) })
  )

  // Next turn in the same chat, still linked to the thread: item mail woke it, so nothing goes to Slack.
  expect(await replyIn(itemMail)).toBe('turn_stays_in_orca')
  expect(reply).not.toHaveBeenCalled()

  expect(await replyIn(threadWorkerReport)).toBe('posted')
})
