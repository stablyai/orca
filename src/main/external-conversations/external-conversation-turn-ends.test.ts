import { expect, it } from 'vitest'
import { mergedTurns } from '../native-chat/agent-session-wire/observations/structured-agent-session-turn-completion-feed'
import { threadBotTurnReply, type ChatTurnEnd } from './external-conversation-turn-ends'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { EndedChatTurn } from './external-conversation-ended-turn'

const WARNING = 'I replied but the message may not have reached you. Please ask again.'
const link: ExternalConversationLink = {
  source: 'slack',
  externalId: 'thread',
  sessionId: 'chat-1',
  agent: 'codex',
  paneKey: 'pane',
  bot: { kind: 'bot', botId: 'bot-1' },
  createdAt: 0
}
// Worker mail woke the chat and the bot ended that turn quietly.
const quiet: EndedChatTurn = { lastAssistantMessage: 'NO_REPLY' }
const stamped = (externalId: string): Pick<EndedChatTurn, 'stamps'> => ({
  stamps: [{ account: 'a', conversation: { source: 'slack', externalId }, deliveryId: 'd' }]
})

async function told(mergedTurnCount: number | undefined, merged?: Pick<EndedChatTurn, 'stamps'>[]) {
  const end: ChatTurnEnd = {
    ended: {
      kind: 'turn-ended',
      conversation: { source: 'slack', externalId: 'thread' },
      worktreeId: 'wt',
      paneKey: 'pane',
      turnId: null,
      stopReason: 'success',
      at: 0
    },
    news: {
      kind: 'turn-ended',
      sessionId: 'chat-1',
      outcome: 'success',
      ...(mergedTurnCount === undefined ? {} : { mergedTurnCount }),
      ...(merged ? { readMergedAttributions: async () => merged } : {}),
      readTurn: async () => quiet,
      at: 0
    },
    agent: 'codex',
    emit: () => {},
    turnFor: () => ({}),
    workersChecked: async () => undefined,
    current: () => true
  }
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
