import { expect, it } from 'vitest'
import { makeTestBotItem } from '../../../../src/shared/bots/bot-item.test-fixture'
import {
  KEPT_BOT_ITEM_ASK_CARDS,
  readBotItemAskCardDraft,
  retireBotItemAskCardDraft,
  saveBotItemAskCardDraft
} from './bot-item-ask-card-drafts'

const typed = (other: string) => ({ '0': { picks: [], other } })
const save = (key: string, other = `words for ${key}`) =>
  saveBotItemAskCardDraft(key, 'e1', typed(other))

it('keeps only the last cards edited, so items closed elsewhere after you left them don’t pile up', () => {
  const keys = Array.from({ length: KEPT_BOT_ITEM_ASK_CARDS + 5 }, (_, at) => `host\0bot\0a-${at}`)
  keys.forEach((key) => save(key))

  keys.slice(0, 5).forEach((key) => expect(readBotItemAskCardDraft(key, 'e1')).toBeUndefined())
  keys
    .slice(5)
    .forEach((key) => expect(readBotItemAskCardDraft(key, 'e1')).toEqual(typed(`words for ${key}`)))
})

it('keeps the card being edited, though older cards were saved after it was opened', () => {
  const composing = 'host\0bot\0b-composing'
  save(composing, 'first words')
  for (let at = 0; at < KEPT_BOT_ITEM_ASK_CARDS - 1; at++) {
    save(`host\0bot\0b-${at}`)
  }
  // Typing again makes it the newest; the next saves push out the others first.
  save(composing, 'first words, then more')
  save('host\0bot\0b-late-1')
  save('host\0bot\0b-late-2')

  expect(readBotItemAskCardDraft(composing, 'e1')).toEqual(typed('first words, then more'))
  expect(readBotItemAskCardDraft('host\0bot\0b-0', 'e1')).toBeUndefined()
  expect(readBotItemAskCardDraft('host\0bot\0b-1', 'e1')).toBeUndefined()
  expect(readBotItemAskCardDraft('host\0bot\0b-2', 'e1')).toEqual(typed('words for host\0bot\0b-2'))
})

it('keeps a card its open page still shows waiting, though other cards were edited since it was typed', () => {
  const opened = 'host\0bot\0c-opened'
  save(opened, 'typed before leaving')
  for (let at = 0; at < KEPT_BOT_ITEM_ASK_CARDS - 1; at++) {
    save(`host\0bot\0c-${at}`)
  }
  // Opened again without typing: the host still names its ask.
  retireBotItemAskCardDraft(
    opened,
    makeTestBotItem(1, { status: 'needs_you', waitingAsk: 'e1' }),
    []
  )
  save('host\0bot\0c-late')

  expect(readBotItemAskCardDraft(opened, 'e1')).toEqual(typed('typed before leaving'))
  expect(readBotItemAskCardDraft('host\0bot\0c-0', 'e1')).toBeUndefined()
})
