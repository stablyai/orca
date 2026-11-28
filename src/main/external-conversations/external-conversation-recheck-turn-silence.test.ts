// A question re-check wakes the bot's Home Chat with Orca's item mail. Whatever the bot ends that turn
// with, no connector conversation gets it: the Chat's shared link tells nothing of a turn begun in
// Orca, a thread chat's tells only how it went, and a bot's Chat may not post mid-turn.
import { expect, it } from 'vitest'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { BOT_ITEM_MAIL_SENDER } from '../../shared/bots/bot-item-mail-sender'
import { botReplyRefusal } from './external-conversation-bots'
import type { ChatNews } from './external-conversation-chat'
import { ChatTurns } from './external-conversation-chat-turns'
import type { EndedChatTurn } from './external-conversation-ended-turn'
import type { ConversationEvent } from './external-conversation-events'
import type { ReplyTarget } from './external-conversation-types'

const HOME = '54889ba4-947c-4531-8221-8ab6aea262a9'
const thread = { source: 'slack' as const, externalId: 'T0TEAM:D0OWNER:1.0:U0BOT' }

// The re-check mail that opened the turn: Orca's item sender, no conversation it answers.
const recheckMail = {
  itemId: 'mail',
  revision: 0,
  sequence: 3,
  observedAt: 3,
  body: {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Item question re-check' }],
    from: {
      kind: 'agent',
      senders: [{ party: { handle: BOT_ITEM_MAIL_SENDER }, name: 'Orca' }],
      orchestration: {
        message: 'mail-notice',
        mailbox: `orca_session_id:${HOME}`,
        dispatchId: null,
        messages: [{ messageId: 'msg_item_recheck_e41', runId: 'run', from: BOT_ITEM_MAIL_SENDER }]
      }
    }
  }
} as unknown as NonNullable<EndedChatTurn['opener']>

async function endRecheckTurn(
  bot: NonNullable<ExternalConversationLink['bot']>,
  lastAssistantMessage: string
): Promise<ConversationEvent[]> {
  const link: ExternalConversationLink = {
    ...thread,
    sessionId: HOME,
    agent: 'claude',
    paneKey: 'pane',
    bot,
    createdAt: 0
  }
  const turn: EndedChatTurn = { lastAssistantMessage, opener: recheckMail, stamps: [] }
  const events: ConversationEvent[] = []
  const chats = new ChatTurns({
    setTimer: () => ({ cancel: () => {} }),
    now: () => 10,
    workerActivities: async () => null,
    linkedFor: () => ({ link, workspace: { worktreeId: 'wt', sshHostId: null } }),
    emit: (event) => events.push(event),
    readHookRow: () => null,
    pendingPrompt: () => null,
    // Mail opened it: no connector delivery was sent into this turn.
    chatTurnOrigin: () => 'local',
    chatTurnDelivered: () => false,
    chatTurnDelivery: () => undefined,
    chatTurnWaiting: () => false,
    runningTurnReported: () => false,
    workLinks: async () => [],
    promptsAudience: () => true,
    turnOpener: () => recheckMail,
    keepAdoptedTurn: () => {}
  })
  const news: ChatNews = {
    kind: 'turn-ended',
    sessionId: HOME,
    outcome: 'success',
    readTurn: async () => turn,
    at: 10
  }
  chats.news(news)
  // Every read the end makes is a resolved promise; let them all settle.
  for (let index = 0; index < 20; index++) {
    await Promise.resolve()
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  return events
}

it("keeps a re-check turn's final words in Orca, compliant or not", async () => {
  for (const words of ['NO_REPLY', 'Still needed, nothing changed.', 'Checked. NO_REPLY']) {
    // Home Chat carrying the owner's DM: a turn begun in Orca tells the DM nothing.
    expect(await endRecheckTurn({ kind: 'bot-chat', botId: 'bot-1' }, words)).toEqual([])
    // A thread's own chat (never a re-check's target, kept as the worst case): no words leave.
    const ends = await endRecheckTurn({ kind: 'bot', botId: 'bot-1' }, words)
    expect(ends.every((event) => !('lastAssistantMessage' in event))).toBe(true)
  }
})

it("refuses a mid-turn bot reply from the bot's Chat", () => {
  const target: ReplyTarget = {
    key: thread,
    turnId: 7,
    worktreeId: 'wt',
    bot: { kind: 'bot-chat', botId: 'bot-1' },
    place: "the owner's DM"
  }
  expect(botReplyRefusal(target, [{ id: 'bot-1', folderWorkspaceId: 'home' }])).toBe(
    'bot_chat_reply'
  )
})
