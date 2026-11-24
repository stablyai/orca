import { expect, it } from 'vitest'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { ChatNews } from './external-conversation-chat'
import { ChatTurns } from './external-conversation-chat-turns'
import type { EndedChatTurn } from './external-conversation-ended-turn'
import type { ConversationEvent } from './external-conversation-events'
import type { EndedTurnReplies } from './external-conversation-reply-fill'
import { THREAD_LEFT_LINE } from './external-conversation-leave-lines'

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
  let carried = 0
  let reads = 0
  // The thread owes TURN's line while it is still left.
  const leaveLines = {
    owed: (_link: unknown, turnId: number) => {
      const owes = turnId === TURN && !options.undone && !(options.undoneWhileReading && reads > 0)
      reads += 1
      return owes
    },
    carried: () => {
      carried += 1
    },
    // As the real one: nothing posts once the thread no longer owes it.
    post: () => {
      if (!options.undone && !options.undoneWhileReading) {
        posted += 1
      }
    },
    ending: () => {},
    handOff: async () => {},
    restore: () => {}
  }
  const events: ConversationEvent[] = []
  const prose: string[] = []
  const fill = async (replies: EndedTurnReplies) => {
    prose.push(replies.proseNow?.() ?? replies.prose)
    return { covered: new Set([thread.externalId]), paused: false, answered: true as const }
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
  return { said: ended?.lastAssistantMessage, prose, posted, carried }
}

it('confirms a leave once, after the answer, and only while the thread is still left', async () => {
  // An end outside the reply outbox may reach no one: the line posts on its own, kept owed.
  expect(await endLeftTurn({ lastAssistantMessage: 'Noted #123.' })).toEqual({
    said: 'Noted #123.',
    prose: [],
    posted: 1,
    carried: 0
  })
  // Through the reply outbox: the answer's prose carries it.
  const outboxed = await endLeftTurn(
    {
      lastAssistantMessage: 'Summary: canary is green.',
      turnProse: 'Summary: canary is green.',
      turnItemId: 'turn-1',
      stamps: [{ account: 'acct', conversation: thread, deliveryId: 'd1' }]
    },
    { outbox: true }
  )
  expect(outboxed).toEqual({
    said: undefined,
    prose: [`Summary: canary is green.\n\n${THREAD_LEFT_LINE}`],
    posted: 0,
    carried: 1
  })
  // A quiet answer through the outbox: the line is the answer.
  const quiet = await endLeftTurn(
    {
      lastAssistantMessage: 'NO_REPLY',
      turnProse: 'NO_REPLY',
      turnItemId: 'turn-1',
      stamps: [{ account: 'acct', conversation: thread, deliveryId: 'd1' }]
    },
    { outbox: true }
  )
  expect(quiet.prose).toEqual([THREAD_LEFT_LINE])
  // Too long to keep the line whole: it posts on its own.
  const long = 'a'.repeat(8_000)
  expect(
    await endLeftTurn(
      {
        lastAssistantMessage: long,
        turnProse: long,
        turnItemId: 'turn-1',
        stamps: [{ account: 'acct', conversation: thread, deliveryId: 'd1' }]
      },
      { outbox: true }
    )
  ).toMatchObject({ prose: [long], posted: 1, carried: 0 })
  // A failed turn: its end says only what it said, and the line posts on its own once.
  expect(
    await endLeftTurn({ lastAssistantMessage: 'Partial.' }, { outcome: 'failure' })
  ).toMatchObject({ said: 'Partial.', posted: 1, carried: 0 })
  // An @mention while the turn was being read: no line at all.
  expect(
    await endLeftTurn(
      {
        lastAssistantMessage: 'Ok.',
        turnProse: 'Ok.',
        turnItemId: 'turn-1',
        stamps: [{ account: 'acct', conversation: thread, deliveryId: 'd1' }]
      },
      { outbox: true, undoneWhileReading: true }
    )
  ).toMatchObject({ prose: ['Ok.'], posted: 0 })
  // An @mention brought it back first: no line at all.
  expect(await endLeftTurn({ lastAssistantMessage: 'Ok.' }, { undone: true })).toEqual({
    said: 'Ok.',
    prose: [],
    posted: 0,
    carried: 0
  })
})
