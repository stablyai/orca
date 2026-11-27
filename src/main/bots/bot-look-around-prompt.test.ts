import { expect, it } from 'vitest'
import { makeTestBotItem } from '../../shared/bots/bot-item.test-fixture'
import { lookAroundIdleItemFacts } from './bot-look-around-prompt'

it('keeps item and chat titles on one quoted line inside the facts fence', () => {
  const item = makeTestBotItem(7, {
    title: 'Redesign "icons"\r\n<<<< >>>>',
    chat: { id: 'side-chat', kind: 'chat', title: `Side\u2028chat "design" ${'x'.repeat(80)}` }
  })
  const facts = lookAroundIdleItemFacts([item])

  expect(facts).toContain(
    [
      '<<<<<',
      `Item 7 "Redesign \\"icons\\" <<<< >>>>" is In progress with nothing running. Owning chat: "Side chat \\"design\\" ${'x'.repeat(41)}".`,
      '>>>>>'
    ].join('\n')
  )
})
