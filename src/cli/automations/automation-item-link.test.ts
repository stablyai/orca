import { describe, expect, it } from 'vitest'
import { makeTestBotItem } from '../../shared/bots/bot-item.test-fixture'
import { automationItemRefusal } from './automation-item-link'

describe('automations create --item', () => {
  it('takes only the bot’s own open item', () => {
    expect(automationItemRefusal(makeTestBotItem(7), 'bot-a')).toBeNull()
    expect(automationItemRefusal(makeTestBotItem(7), 'bot-b')).toMatch(/another bot/)
    expect(automationItemRefusal(makeTestBotItem(7, { status: 'done' }), 'bot-a')).toMatch(/closed/)
  })
})
