import { expect, it } from 'vitest'
import { botTurnReply } from './external-conversation-turn-ends'

const end = (mergedTurnCount?: number) =>
  ({ news: mergedTurnCount === undefined ? {} : { mergedTurnCount } }) as Parameters<
    typeof botTurnReply
  >[0]
const link = {
  source: 'slack',
  externalId: 'thread',
  sessionId: 'chat-1',
  agent: 'codex',
  paneKey: 'pane',
  bot: { kind: 'bot', botId: 'bot-1' },
  createdAt: 0
} as Parameters<typeof botTurnReply>[1]
const quiet = { lastAssistantMessage: 'NO_REPLY' } as Parameters<typeof botTurnReply>[2]

it('keeps a merged quiet completion warning while a single quiet completion stays silent', () => {
  expect(botTurnReply(end(), link, quiet, true)).toBeUndefined()
  expect(botTurnReply(end(2), link, quiet, true)).toBe(
    'I replied but the message may not have reached you. Please ask again.'
  )
})
