import { expect, it } from 'vitest'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { ChatNews } from './external-conversation-chat'
import { ChatTurns } from './external-conversation-chat-turns'
import type { EndedChatTurn } from './external-conversation-ended-turn'
import type { ConversationEvent } from './external-conversation-events'
import type { ConversationReplyFill } from './external-conversation-reply-fill'

const thread = { source: 'slack' as const, externalId: 'T0TEAM:C0CHANNEL:1.0:U0BOT' }
const link: ExternalConversationLink = {
  ...thread,
  sessionId: 'chat-1',
  agent: 'claude',
  paneKey: 'pane',
  bot: { kind: 'bot-chat', botId: 'bot-1' },
  createdAt: 0
}
// The worker's "setup succeeded" mail woke the chat, not the thread's own message.
const workerMail = {
  itemId: 'mail',
  revision: 0,
  sequence: 3,
  observedAt: 3,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Setup succeeded.' }] }
} satisfies NonNullable<EndedChatTurn['opener']>

async function endTurn(
  turn: EndedChatTurn,
  fill?: ConversationReplyFill
): Promise<Extract<ConversationEvent, { kind: 'turn-ended' }>[]> {
  const events: ConversationEvent[] = []
  const chats = new ChatTurns({
    setTimer: () => ({ cancel: () => {} }),
    now: () => 10,
    workerActivities: async () => null,
    linkedFor: () => ({ link, workspace: { worktreeId: 'wt', sshHostId: null } }),
    emit: (event) => events.push(event),
    readHookRow: () => null,
    pendingPrompt: () => null,
    // The thread's delivery is still marked on the chat: its answering end was held, never told.
    chatTurnOrigin: () => 'delivery',
    chatTurnDelivered: () => true,
    chatTurnDelivery: () => undefined,
    chatTurnWaiting: () => false,
    runningTurnReported: () => false,
    workLinks: async () => [],
    promptsAudience: () => true,
    turnOpener: () => null,
    keepAdoptedTurn: () => {},
    keepWakeAnswers: () => {},
    ...(fill ? { replyFill: () => fill } : {})
  })
  // An older host still reports the turns its quiet end merged; that count proves nothing.
  const news: ChatNews & { mergedTurnCount: number } = {
    kind: 'turn-ended',
    sessionId: link.sessionId,
    outcome: 'success',
    mergedTurnCount: 2,
    readTurn: async () => turn,
    at: 10
  }
  chats.news(news)
  await expect.poll(() => events.length).toBe(1)
  return events.filter((event) => event.kind === 'turn-ended')
}

it('ends a quiet turn with no words, whatever turns came before it', async () => {
  const quiet = { lastAssistantMessage: 'NO_REPLY', opener: workerMail, stamps: [] }
  const [legacy] = await endTurn(quiet)
  expect(legacy?.lastAssistantMessage).toBeUndefined()

  // The thread's rows were filled as quiet: the outbox tells the thread, and the end says nothing.
  const stamped = {
    ...quiet,
    turnItemId: 'turn-2',
    turnProse: 'NO_REPLY',
    stamps: [{ account: 'acct', conversation: thread, deliveryId: 'd1' }]
  }
  const [outboxed] = await endTurn(stamped, async () => ({
    covered: new Set([thread.externalId]),
    paused: false
  }))
  expect(outboxed).toMatchObject({ stateOnly: true })
  expect(outboxed?.lastAssistantMessage).toBeUndefined()

  // A turn that said something still says it.
  const [answered] = await endTurn({ ...quiet, lastAssistantMessage: 'The fix is in.' })
  expect(answered?.lastAssistantMessage).toBe('The fix is in.')
})
