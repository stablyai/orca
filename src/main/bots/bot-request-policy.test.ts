import { describe, expect, it } from 'vitest'
import { makeTestBot } from './bot.test-fixture'
import { botNotFound, botRequestRefusal, type BotRequestCheck } from './bot-request-policy'

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

  it('lets the owner hand off, ask and send status', () => {
    expect(botRequestRefusal(check())).toBeNull()
    expect(botRequestRefusal(check({ type: 'question' }))).toBeNull()
    expect(botRequestRefusal(check({ type: 'status' }))).toBeNull()
  })

  it("lets a bot mail another of its own chats, as it would another bot's", () => {
    expect(botRequestRefusal(check({ senderBotId: 'docs', toOtherChat: true }))).toBeNull()
  })

  it('refuses each case in one sentence that says what to do instead', () => {
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
      expect(refusal?.message.split('. ')).toHaveLength(1)
      expect(refusal?.message).toMatch(/, so /)
    }
  })
})

describe('botNotFound', () => {
  it('lists the bots there are, quoted when a shell would split them', () => {
    expect(botNotFound('Doc', [{ name: 'Docs' }, { name: 'Release Notes' }]).message).toBe(
      'There is no bot named Doc on this computer (its bots: bot:Docs, "bot:Release Notes"), so pick one of those or do the work yourself.'
    )
    expect(botNotFound('Doc', []).message).toMatch(/no other bot on this computer/)
  })
})
