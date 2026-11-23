import { expect, it } from 'vitest'
import { mergedTurns } from '../native-chat/agent-session-wire/observations/structured-agent-session-turn-completion-feed'
import { threadBotTurnReply } from './external-conversation-turn-ends'
import type { EndedChatTurn } from './external-conversation-ended-turn'

type End = Parameters<typeof threadBotTurnReply>[0]
const WARNING = 'I replied but the message may not have reached you. Please ask again.'
const link = {
  source: 'slack',
  externalId: 'thread',
  sessionId: 'chat-1',
  agent: 'codex',
  paneKey: 'pane',
  bot: { kind: 'bot', botId: 'bot-1' },
  createdAt: 0
} as Parameters<typeof threadBotTurnReply>[1]
// Worker mail woke the chat and the bot ended that turn quietly.
const quiet = {
  lastAssistantMessage: 'NO_REPLY',
  opener: { body: { kind: 'message', role: 'user', origin: 'orca' } }
} as unknown as EndedChatTurn
const stamped = (externalId: string): Pick<EndedChatTurn, 'stamps'> => ({
  stamps: [{ conversation: { source: 'slack', externalId } }] as EndedChatTurn['stamps']
})

async function told(mergedTurnCount: number | undefined, merged?: Pick<EndedChatTurn, 'stamps'>[]) {
  const end = {
    news: {
      ...(mergedTurnCount === undefined ? {} : { mergedTurnCount }),
      ...(merged ? { readMergedAttributions: async () => merged } : {})
    }
  } as End
  return threadBotTurnReply(end, link, quiet, true)
}

it('warns on a merged quiet end only when a merged answer may not have reached the thread', async () => {
  expect(await told(undefined)).toBeUndefined()
  // #46938: the thread's answer was held behind worker mail; its outbox row posts it.
  expect(await told(2, [stamped('thread')])).toBeUndefined()
  // An answer no delivery stamped (or one to another thread) has no row here: it would be lost.
  expect(await told(2, [{}])).toBe(WARNING)
  expect(await told(3, [stamped('thread'), stamped('other')])).toBe(WARNING)
  // Merged answers unknown (older host, or a full window): keep the warning.
  expect(await told(2)).toBe(WARNING)
})

it('names merged answering turns only when every one is known', () => {
  const turns = [
    { id: 'old', sequence: 1, answered: true },
    { id: 'answer', sequence: 5, answered: true },
    { id: 'quiet', sequence: 6, answered: false }
  ]
  const accounted = { through: 2, settled: null }
  expect(mergedTurns({ turnsBehind: { turns, more: false } }, accounted)).toEqual({
    mergedTurnCount: 2,
    mergedAnsweredTurnIds: ['answer']
  })
  const full = turns.slice(1)
  expect(mergedTurns({ turnsBehind: { turns: full, more: true } }, accounted)).toEqual({
    mergedTurnCount: 3
  })
})
