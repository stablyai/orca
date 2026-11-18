import { expect, it } from 'vitest'
import { makeTestBotItem } from '../../shared/bots/bot-item.test-fixture'
import { formatBotItemShow } from './bot-items-format'

const BOT = { kind: 'bot', botId: 'bot-a', chatId: 'chat-home' } as const

it('names status moves in show with the words the header uses, never the stored value', () => {
  const text = formatBotItemShow({
    item: makeTestBotItem(6),
    events: [
      { id: 'e1', kind: 'status', actor: BOT, data: { from: 'planned', to: 'working' }, at: 1 },
      { id: 'e2', kind: 'status', actor: BOT, data: { from: 'working', to: 'needs_you' }, at: 2 }
    ]
  })

  expect(text).toContain('e1  Planned → In progress')
  expect(text).toContain('e2  In progress → Needs you')
  expect(text).not.toMatch(/\bworking\b/)
})
