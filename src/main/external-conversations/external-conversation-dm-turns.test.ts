import { describe, expect, it } from 'vitest'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { chatPaneKey } from './external-conversation-chat'
import { ChatTurns } from './external-conversation-chat-turns'
import type { EndedChatTurn } from './external-conversation-ended-turn'
import type { ConversationEvent } from './external-conversation-events'
import type { ConversationReplyFill } from './external-conversation-reply-fill'

// A bot answering its owner's DM (the 2026-11-20 ids).
const SESSION = 'bot-chat-session'
const DM = 'T05BHT77GUF:D0CH5QFFC2C:D0CH5QFFC2C:U0CGB82KBC2'
const THREAD = 'T05BHT77GUF:C0CCNS3K8BU:1795218253.690759:U0CGB82KBC2'

// As the journal stamps a delivery the turn answered (connectorReplyTurnStamps).
const stamp = (externalId = DM) => ({
  account: 'acct',
  conversation: { source: 'slack', externalId },
  deliveryId: 'slack:dm:1'
})

function chat(input: {
  kind?: 'bot' | 'bot-chat'
  externalId?: string
  delivered?: boolean
  replyFill?: ConversationReplyFill
}) {
  const link: ExternalConversationLink = {
    source: 'slack',
    externalId: input.externalId ?? DM,
    sessionId: SESSION,
    agent: 'claude',
    paneKey: chatPaneKey(SESSION),
    bot: { kind: input.kind ?? 'bot-chat', botId: 'b1' },
    createdAt: 0
  }
  const events: ConversationEvent[] = []
  const delivered = input.delivered ?? false
  const turns = new ChatTurns({
    promptsAudience: () => false,
    turnOpener: () => null,
    keepAdoptedTurn: () => {},
    readHookRow: () => ({
      paneKey: link.paneKey,
      tabId: 'tab',
      worktreeId: 'folder:bot-home',
      connectionId: null,
      structuredHost: 'owned',
      state: 'working',
      prompt: '',
      agentType: 'claude',
      receivedAt: 500,
      stateStartedAt: 500
    }),
    pendingPrompt: () => null,
    chatTurnOrigin: () => (delivered ? 'delivery' : 'local'),
    chatTurnDelivered: () => delivered,
    chatTurnDelivery: () => undefined,
    chatTurnWaiting: () => false,
    runningTurnReported: () => false,
    workLinks: async () => [],
    workerActivities: async () => null,
    linkedFor: () => ({ link, workspace: { worktreeId: 'folder:bot-home', sshHostId: null } }),
    emit: (event) => events.push(event),
    setTimer: () => ({ cancel: () => {} }),
    now: () => 500,
    ...(input.replyFill ? { replyFill: () => input.replyFill ?? null } : {})
  })
  const end = async (turn: EndedChatTurn, mergedTurnCount?: number) => {
    turns.observe(link.paneKey)
    turns.news({
      kind: 'turn-ended',
      sessionId: SESSION,
      outcome: 'success',
      at: 600,
      ...(mergedTurnCount ? { mergedTurnCount } : {}),
      readTurn: async () => turn
    })
    // Let the end's reads settle: every one is a resolved promise, so draining microtasks is enough.
    for (let tick = 0; tick < 100; tick += 1) {
      await Promise.resolve()
    }
  }
  const ended = () => events.flatMap((event) => (event.kind === 'turn-ended' ? [event] : []))
  const started = () => events.filter((event) => event.kind === 'turn-started')
  return { end, ended, started }
}

describe('a DM turn’s answer on the legacy turn end', () => {
  // Only a chat with no reply outbox at all gets here (an installed host always has one).
  it('keeps a thread the bot follows quiet when it ends with its marker', async () => {
    const h = chat({ kind: 'bot', externalId: THREAD, delivered: true })
    await h.end({
      lastAssistantMessage: 'Not for me.\n\nNO_REPLY',
      stamps: [stamp(THREAD)],
      turnItemId: 'turn-1'
    })
    expect(h.ended()).toHaveLength(1)
    expect(h.ended()[0]).not.toHaveProperty('lastAssistantMessage')
  })
})
