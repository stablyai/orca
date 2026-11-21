import { describe, expect, it, vi } from 'vitest'
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

// As the journal marks a delivery its bot's owner sent (connectorReplyTurnStamps).
const stamp = (externalId = DM, ownerAsked = true) => ({
  account: 'acct',
  conversation: { source: 'slack', externalId },
  deliveryId: 'slack:dm:1',
  ...(ownerAsked ? { ownerAsked: true as const } : {})
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
  // Only a chat with no reply outbox at all gets here (an installed host always has one), so no
  // row can post the answer too; with an outbox, the tests below show the legacy end never does.
  it('posts the words a bot wrote before its marker to the DM the turn answered', async () => {
    const h = chat({ kind: 'bot', delivered: true })
    await h.end({
      lastAssistantMessage: 'Both fixes are with review.\n\nNO_REPLY',
      stamps: [stamp()],
      turnItemId: 'turn-1'
    })
    expect(h.ended()).toEqual([
      expect.objectContaining({
        origin: 'delivery',
        lastAssistantMessage: 'Both fixes are with review.'
      })
    ])
  })

  it('keeps a member’s DM quiet, as before', async () => {
    const h = chat({ kind: 'bot', delivered: true })
    await h.end({
      lastAssistantMessage: 'Owner-only note on #12.\n\nNO_REPLY',
      stamps: [stamp(DM, false)],
      turnItemId: 'turn-1'
    })
    expect(h.ended()).toHaveLength(1)
    expect(h.ended()[0]).not.toHaveProperty('lastAssistantMessage')
  })

  it('keeps a thread the bot follows quiet, as before', async () => {
    const h = chat({ kind: 'bot', externalId: THREAD, delivered: true })
    await h.end({
      lastAssistantMessage: 'Not for me.\n\nNO_REPLY',
      stamps: [stamp(THREAD)],
      turnItemId: 'turn-1'
    })
    expect(h.ended()).toHaveLength(1)
    expect(h.ended()[0]).not.toHaveProperty('lastAssistantMessage')
  })

  it('posts no words when its outbox fill threw, so recovery posts the answer once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = chat({
      kind: 'bot',
      delivered: true,
      replyFill: async () => {
        throw new Error('database is locked')
      }
    })
    await h.end({
      lastAssistantMessage: 'Both fixes are with review.\n\nNO_REPLY',
      stamps: [stamp()],
      turnItemId: 'turn-1'
    })
    expect(h.ended()).toHaveLength(1)
    expect(h.ended()[0]).not.toHaveProperty('lastAssistantMessage')
    warn.mockRestore()
  })

  it('never adds the merged-quiet notice to a DM whose words the outbox posts', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const replyFill = vi.fn<ConversationReplyFill>(async () => ({
      covered: new Set([DM]),
      paused: false
    }))
    const h = chat({ kind: 'bot', delivered: true, replyFill })
    await h.end(
      {
        lastAssistantMessage: 'Both fixes are with review.\n\nNO_REPLY',
        stamps: [stamp()],
        turnItemId: 'turn-1'
      },
      2
    )
    expect(h.ended()).toEqual([expect.objectContaining({ stateOnly: true })])
    expect(h.ended()[0]).not.toHaveProperty('lastAssistantMessage')
    vi.restoreAllMocks()
  })

  it('never posts a DM’s words from a turn its journal doesn’t prove answered it', async () => {
    const h = chat({ kind: 'bot', delivered: true })
    await h.end({ lastAssistantMessage: 'Done.\n\nNO_REPLY', stamps: [], turnItemId: 'turn-1' })
    expect(h.ended()[0]).not.toHaveProperty('lastAssistantMessage')
  })
})
