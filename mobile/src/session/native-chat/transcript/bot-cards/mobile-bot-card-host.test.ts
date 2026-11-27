import { expect, it } from 'vitest'
import { mobileBotOfferTell } from './mobile-bot-card-host'

it('answers as a card answer on a host that takes one, and typed on an older host', async () => {
  const typed: string[] = []
  const answered: [string, string, string][] = []
  const card = { typed: async (text: string) => (typed.push(text), true), sessionId: 'chat-1' }
  const cardAnswer = async (text: string, sessionId: string, answerKey: string) => (
    answered.push([text, sessionId, answerKey]),
    true
  )

  await expect(mobileBotOfferTell(card, cardAnswer, 'Dismiss', 'card-1\ndismissed')).resolves.toBe(
    true
  )
  // The key goes with it, so a host that already queued this answer tells the bot nothing new.
  expect(answered).toEqual([['Dismiss', 'chat-1', 'card-1\ndismissed']])
  expect(typed).toEqual([])

  // An older host has no card answer: the phone types, as it always did.
  await expect(mobileBotOfferTell(card, null, 'Import all of it.', 'card-1\nsent')).resolves.toBe(
    true
  )
  expect(typed).toEqual(['Import all of it.'])
  expect(answered).toHaveLength(1)
})
