import { expect, it } from 'vitest'
import { mobileBotOfferTell } from './mobile-bot-card-host'
import { botOfferAnswerSend } from './mobile-bot-card-operations'

it('answers as a card answer on a host that takes one, and typed on an older host', async () => {
  const typed: string[] = []
  const answered: [string, string][] = []
  const card = { typed: async (text: string) => (typed.push(text), true), sessionId: 'chat-1' }
  const cardAnswer = async (text: string, sessionId: string) => (
    answered.push([text, sessionId]),
    true
  )

  await expect(mobileBotOfferTell(card, cardAnswer, 'Dismiss')).resolves.toBe(true)
  expect(answered).toEqual([['Dismiss', 'chat-1']])
  expect(typed).toEqual([])

  // An older host has no card answer: the phone types, as it always did.
  await expect(mobileBotOfferTell(card, null, 'Import all of it.')).resolves.toBe(true)
  expect(typed).toEqual(['Import all of it.'])
  expect(answered).toHaveLength(1)
})

it('decodes the choice the host already recorded on an offer card', async () => {
  const outcome = await botOfferAnswerSend.request(
    {
      sendRequest: async () => ({
        ok: true,
        id: 'answer',
        result: { sent: true, answer: { cardId: 'plan', sent: { chosen: ['1', '2'] } } }
      })
    },
    {
      botId: 'bot',
      sessionId: 'chat',
      text: 'Import 1',
      answer: { cardId: 'plan', sent: { chosen: ['1'] } }
    }
  )
  expect(botOfferAnswerSend.interpret(outcome)).toEqual({
    sent: true,
    answer: { cardId: 'plan', sent: { chosen: ['1', '2'] } }
  })
})
