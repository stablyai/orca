import { expect, it } from 'vitest'
import { botTurnReply } from './external-conversation-turn-ends'

const reply = 'I replied but the message may not have reached you. Please ask again.'
const end = { news: { mergedTurnCount: 2 } } as Parameters<typeof botTurnReply>[0]
const link = {
  source: 'slack',
  externalId: 'thread',
  sessionId: 'chat-1',
  agent: 'codex',
  paneKey: 'pane',
  bot: { kind: 'bot', botId: 'bot-1' },
  createdAt: 0
} as Parameters<typeof botTurnReply>[1]

it('suppresses only a merged quiet completion whose deliveries were answered through the outbox', () => {
  const quiet = { lastAssistantMessage: 'NO_REPLY' } as Parameters<typeof botTurnReply>[2]

  expect({
    deliveredReplyThenQuiet: botTurnReply(end, link, quiet, true, true),
    quietOnly: botTurnReply({ ...end, news: {} }, link, quiet, true),
    rowsLessDelivery: botTurnReply(end, link, quiet, true, false),
    undeliveredReply: botTurnReply(end, link, quiet, true, false)
  }).toEqual({
    deliveredReplyThenQuiet: undefined,
    quietOnly: undefined,
    rowsLessDelivery: reply,
    undeliveredReply: reply
  })
})
