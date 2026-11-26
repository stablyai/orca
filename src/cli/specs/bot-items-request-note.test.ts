import { expect, it } from 'vitest'
import { BOT_ITEM_COMMAND_SPECS } from './bot-items'

it('item add help promises the reports’ place for --request, and a link only while there is room', () => {
  const add = BOT_ITEM_COMMAND_SPECS.find((spec) => spec.path.join(' ') === 'bot item add')
  const note = add?.notes?.find((line) => line.includes('--request'))
  expect(add?.allowedFlags).toContain('request')
  expect(note).toContain('the reports of its workers say to post results in the thread')
  expect(note).toContain('links that place while it has room for links')
  expect(note).not.toContain('it links the thread')
})
