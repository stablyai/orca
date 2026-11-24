import { expect, it } from 'vitest'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { ChatNews } from './external-conversation-chat'
import { ChatTurns } from './external-conversation-chat-turns'
import type { EndedChatTurn } from './external-conversation-ended-turn'
import type { ConversationEvent } from './external-conversation-events'
import type { EndedTurnReplies } from './external-conversation-reply-fill'

const thread = { source: 'slack' as const, externalId: 'T0TEAM:C0CHANNEL:1.0:U0BOT' }
const link: ExternalConversationLink = {
  ...thread,
  sessionId: 'chat-1',
  agent: 'claude',
  paneKey: 'pane',
  bot: { kind: 'bot', botId: 'bot-1' },
  createdAt: 0
}
const TURN = 5

/** Ends turn TURN, which left its thread (still left unless `undone`): what the end said and
 *  how often the line posted on its own. */
async function endLeftTurn(
  turn: EndedChatTurn,
  options: {
    outcome?: 'success' | 'failure'
    outbox?: boolean
    undone?: boolean
    /** An @mention lands after the end began, before the turn is read. */
    undoneWhileReading?: boolean
  } = {}
) {
  let posted = 0
  let reads = 0
  // The thread owes TURN's line while it is still left.
  const leaveLines = {
    owed: (_link: unknown, turnId: number) => {
      const owes = turnId === TURN && !options.undone && !(options.undoneWhileReading && reads > 0)
      reads += 1
      return owes
    },
    // As the real one: nothing posts once the thread no longer owes it.
    post: () => {
      if (!options.undone && !options.undoneWhileReading) {
        posted += 1
      }
    },
    ending: () => {},
    // Posts once the cloud takes the end just emitted, which these ends always reach.
    afterTurnEnd: () => leaveLines.post()
  }
  const events: ConversationEvent[] = []
  const prose: string[] = []
  const fill = async (replies: EndedTurnReplies) => {
    prose.push(replies.prose)
    return { covered: new Set([thread.externalId]), paused: false }
  }
  const chats = new ChatTurns({
    setTimer: () => ({ cancel: () => {} }),
    now: () => 10,
    workerActivities: async () => null,
    linkedFor: () => ({ link, workspace: { worktreeId: 'wt', sshHostId: null } }),
    emit: (event) => events.push(event),
    readHookRow: () => null,
    pendingPrompt: () => null,
    chatTurnOrigin: () => 'delivery',
    chatTurnDelivered: () => true,
    chatTurnDelivery: () => undefined,
    chatTurnWaiting: () => false,
    runningTurnReported: () => false,
    workLinks: async () => [],
    promptsAudience: () => true,
    turnOpener: () => null,
    turnStartedAt: () => TURN,
    keepAdoptedTurn: () => {},
    leaveLines,
    ...(options.outbox ? { replyFill: () => fill } : {})
  })
  const news: ChatNews = {
    kind: 'turn-ended',
    sessionId: link.sessionId,
    outcome: options.outcome ?? 'success',
    readTurn: async () => turn,
    at: 10
  }
  chats.news(news)
  await expect.poll(() => events.length).toBe(1)
  await Promise.resolve()
  const ended = events.find((event) => event.kind === 'turn-ended')
  return { said: ended?.lastAssistantMessage, prose, posted }
}

it('confirms a leave once, on its own after the answer, and only while the thread is still left', async () => {
  const outbox = {
    lastAssistantMessage: 'Summary: canary is green.',
    turnProse: 'Summary: canary is green.',
    turnItemId: 'turn-1',
    stamps: [{ account: 'acct', conversation: thread, deliveryId: 'd1' }]
  }
  // The answer is the agent's words alone, through either path; the line posts once after it.
  expect(await endLeftTurn({ lastAssistantMessage: 'Noted #123.' })).toEqual({
    said: 'Noted #123.',
    prose: [],
    posted: 1
  })
  expect(await endLeftTurn(outbox, { outbox: true })).toEqual({
    said: undefined,
    prose: ['Summary: canary is green.'],
    posted: 1
  })
  // A failed turn: its end says only what it said, and the line still posts once.
  expect(
    await endLeftTurn({ lastAssistantMessage: 'Partial.' }, { outcome: 'failure' })
  ).toMatchObject({ said: 'Partial.', posted: 1 })
  // An @mention while the turn was being read, or before it ended: no line at all.
  expect(await endLeftTurn(outbox, { outbox: true, undoneWhileReading: true })).toMatchObject({
    posted: 0
  })
  expect(await endLeftTurn({ lastAssistantMessage: 'Ok.' }, { undone: true })).toEqual({
    said: 'Ok.',
    prose: [],
    posted: 0
  })
})
