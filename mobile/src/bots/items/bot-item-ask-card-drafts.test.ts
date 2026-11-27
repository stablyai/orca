import { expect, it } from 'vitest'
import { makeTestBotItem } from '../../../../src/shared/bots/bot-item.test-fixture'
import type { BotItem } from '../../../../src/shared/bots/bot-items'
import {
  botItemAskCardDraftsClock,
  botItemAskCardKey,
  readBotItemAskCardDraft,
  retireBotItemAskCardDraft,
  retireClosedBotItemAskCardDrafts,
  saveBotItemAskCardDraft
} from './bot-item-ask-card-drafts'

const typed = (other: string) => ({ '0': { picks: [], other } })
const save = (key: string, other = `words for ${key}`) =>
  saveBotItemAskCardDraft(key, 'e1', typed(other))

it('keeps every open item’s card however many were typed since, until the host says it’s over', () => {
  const keys = Array.from({ length: 40 }, (_, at) => botItemAskCardKey('host', 'bot', `a-${at}`))
  saveBotItemAskCardDraft(keys[0]!, 'e1', { '0': { picks: [1], other: 'first words' } })
  keys.slice(1).forEach((key) => save(key))

  expect(readBotItemAskCardDraft(keys[0]!, 'e1')).toEqual({
    '0': { picks: [1], other: 'first words' }
  })
  keys
    .slice(1)
    .forEach((key) => expect(readBotItemAskCardDraft(key, 'e1')).toEqual(typed(`words for ${key}`)))
})

it('drops the cards of items a list read shows closed, and keeps open items’ and other hosts’', () => {
  const card = (host: string, bot: string, uid: string) => botItemAskCardKey(host, bot, uid)
  const done = card('host', 'bot', 'b-done')
  const canceled = card('host', 'bot', 'b-canceled')
  const open = card('host', 'bot', 'b-open')
  const unlisted = card('host', 'bot', 'b-unlisted')
  const otherHost = card('other', 'bot', 'b-done')
  const otherBot = card('host', 'other', 'b-done')
  ;[done, canceled, open, unlisted, otherHost, otherBot].forEach((key) => save(key))

  retireClosedBotItemAskCardDrafts(
    'host',
    'bot',
    [
      { uid: 'b-done', status: 'done' },
      { uid: 'b-canceled', status: 'canceled' },
      { uid: 'b-open', status: 'needs_you' }
    ],
    botItemAskCardDraftsClock()
  )

  expect(readBotItemAskCardDraft(done, 'e1')).toBeUndefined()
  expect(readBotItemAskCardDraft(canceled, 'e1')).toBeUndefined()
  ;[open, unlisted, otherHost, otherBot].forEach((key) =>
    expect(readBotItemAskCardDraft(key, 'e1')).toEqual(typed(`words for ${key}`))
  )
})

it('keeps a card typed or shown waiting after the list read was asked, as its item may have reopened', () => {
  const typedAfter = botItemAskCardKey('host', 'bot', 'c-typed')
  const shownAfter = botItemAskCardKey('host', 'bot', 'c-shown')
  const before = botItemAskCardKey('host', 'bot', 'c-before')
  save(shownAfter)
  save(before)
  const askedAt = botItemAskCardDraftsClock()
  save(typedAfter)
  retireBotItemAskCardDraft(
    shownAfter,
    makeTestBotItem(1, { status: 'needs_you', waitingAsk: 'e1' }),
    []
  )

  retireClosedBotItemAskCardDrafts(
    'host',
    'bot',
    ['c-typed', 'c-shown', 'c-before'].map((uid) => ({ uid, status: 'done' as const })),
    askedAt
  )

  expect(readBotItemAskCardDraft(typedAfter, 'e1')).toEqual(typed(`words for ${typedAfter}`))
  expect(readBotItemAskCardDraft(shownAfter, 'e1')).toEqual(typed(`words for ${shownAfter}`))
  expect(readBotItemAskCardDraft(before, 'e1')).toBeUndefined()
})

it('looks at none of a list read’s rows while only other bots hold cards', () => {
  save(botItemAskCardKey('scan-host', 'other', 'd-1'))
  save(botItemAskCardKey('other-host', 'scan-bot', 'd-2'))
  let visits = 0
  const row = (uid: string): Pick<BotItem, 'uid' | 'status'> => ({
    get uid() {
      visits++
      return uid
    },
    get status(): BotItem['status'] {
      visits++
      return 'done'
    }
  })

  retireClosedBotItemAskCardDrafts(
    'scan-host',
    'scan-bot',
    ['d-1', 'd-2', 'd-3'].map(row),
    botItemAskCardDraftsClock()
  )

  expect(visits).toBe(0)
  expect(
    readBotItemAskCardDraft(botItemAskCardKey('scan-host', 'other', 'd-1'), 'e1')
  ).toBeDefined()
  expect(
    readBotItemAskCardDraft(botItemAskCardKey('other-host', 'scan-bot', 'd-2'), 'e1')
  ).toBeDefined()
})

it('drops a bot’s last card and keeps taking new ones for it', () => {
  const key = botItemAskCardKey('refill-host', 'bot', 'e-1')
  save(key)
  retireClosedBotItemAskCardDrafts(
    'refill-host',
    'bot',
    [{ uid: 'e-1', status: 'canceled' }],
    botItemAskCardDraftsClock()
  )
  expect(readBotItemAskCardDraft(key, 'e1')).toBeUndefined()

  save(key, 'typed again')
  expect(readBotItemAskCardDraft(key, 'e1')).toEqual(typed('typed again'))
})
