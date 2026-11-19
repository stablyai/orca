import { describe, expect, it } from 'vitest'
import { makeTestBot } from './bot.test-fixture'
import { botRequestRefusal, type BotRequestCheck } from './bot-request-policy'

const docs = makeTestBot({ id: 'docs', name: 'Docs' })

describe('botRequestRefusal', () => {
  const check = (overrides: Partial<BotRequestCheck> = {}): BotRequestCheck => ({
    enabled: true,
    target: docs,
    senderBotId: 'ranger',
    toOtherChat: false,
    type: 'handoff',
    ...overrides
  })

  it('accepts the supported request kinds between bots', () => {
    expect(botRequestRefusal(check())).toBeNull()
    expect(botRequestRefusal(check({ type: 'question' }))).toBeNull()
    expect(botRequestRefusal(check({ type: 'status' }))).toBeNull()
  })

  it("lets a bot mail another of its own chats, as it would another bot's", () => {
    expect(botRequestRefusal(check({ senderBotId: 'docs', toOtherChat: true }))).toBeNull()
  })

  it('reports why each unsupported request was refused', () => {
    const cases: [Partial<BotRequestCheck>, string][] = [
      [{ enabled: false }, 'bots_disabled'],
      [{ senderBotId: 'docs' }, 'bot_self'],
      [{ target: { ...docs, paused: true } }, 'bot_paused'],
      [{ type: 'escalation' }, 'bot_request_type'],
      [{ type: undefined }, 'bot_request_type']
    ]
    for (const [overrides, code] of cases) {
      const refusal = botRequestRefusal(check(overrides))
      expect(refusal?.code).toBe(code)
    }
  })
})
