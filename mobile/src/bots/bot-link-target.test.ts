import { describe, expect, it } from 'vitest'
import { parseBotLinkTarget } from './bot-link-target'

const TOKEN = 'a'.repeat(43)

describe('parseBotLinkTarget', () => {
  it('opens a thread link without a session at that conversation', () => {
    expect(parseBotLinkTarget('orca://bot/atlas?conversation=slack%3AC1%3A123.4')).toEqual({
      kind: 'session',
      botId: 'atlas',
      conversation: { source: 'slack', externalId: 'C1:123.4' }
    })
  })

  it('opens a bare bot link at the bot', () => {
    expect(parseBotLinkTarget('orca://bot/atlas')).toEqual({ kind: 'bot', botId: 'atlas' })
  })

  it('reads an access-request link', () => {
    expect(parseBotLinkTarget(`orca://bot/access-request?t=${TOKEN}`)).toEqual({
      kind: 'access-request',
      token: TOKEN
    })
  })

  it('keeps the conversation, session and exact question from a bot link', () => {
    expect(
      parseBotLinkTarget(
        'orca://bot/atlas?conversation=slack%3AC1%3A123.4&session=worker-2&item=question-2'
      )
    ).toEqual({
      kind: 'session',
      botId: 'atlas',
      conversation: { source: 'slack', externalId: 'C1:123.4' },
      sessionId: 'worker-2',
      itemId: 'question-2'
    })
  })

  it('leaves other links alone', () => {
    expect(parseBotLinkTarget('orca://pair?code=abc')).toBeNull()
  })
})
