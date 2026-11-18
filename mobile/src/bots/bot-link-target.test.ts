import { describe, expect, it } from 'vitest'
import { parseBotLinkTarget } from './bot-link-target'

const TOKEN = 'a'.repeat(43)

describe('parseBotLinkTarget', () => {
  it('reads a bot link, with or without a thread', () => {
    expect(parseBotLinkTarget('orca://bot/atlas')).toEqual({ kind: 'bot', botId: 'atlas' })
    expect(parseBotLinkTarget('orca://bot/atlas?conversation=slack%3AC1%3A123.4')).toEqual({
      kind: 'bot',
      botId: 'atlas'
    })
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
    expect(parseBotLinkTarget('orca://bot/access-request?t=short')).toBeNull()
    expect(parseBotLinkTarget('https://bot/atlas')).toBeNull()
  })
})
