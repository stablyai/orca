import { describe, expect, it } from 'vitest'
import { botRequestChatTitle } from './bot-request-view'

const longSender = {
  fromBotId: null,
  fromBotName: 'A bot with an unusually long and descriptive name for reviews',
  fromPairedComputer: 'Review Laptop'
}

describe('request chat titles', () => {
  it('keeps the subject alone for a request to the same bot', () => {
    expect(
      botRequestChatTitle({ fromBotId: 'docs', fromBotName: 'Docs' }, 'docs', 'Update the docs')
    ).toBe('Update the docs')
  })

  it('keeps room for a subject when the sender name is long', () => {
    expect(
      botRequestChatTitle(
        longSender,
        'docs',
        'Urgent review: release your completed retained workers'
      )
    ).toBe('A bot with an unusually long and…: Urgent review: release your completed…')
  })

  it('clips subjects with no usable word boundaries within the title budget', () => {
    const sender = { fromBotId: 'ranger', fromBotName: 'Ranger' }
    expect(botRequestChatTitle(sender, 'docs', `https://example.com/${'a'.repeat(120)}`)).toBe(
      `Ranger: https://example.com/${'a'.repeat(51)}…`
    )
    expect(botRequestChatTitle(sender, 'docs', '审查'.repeat(60))).toBe(
      `Ranger: ${'审查'.repeat(35)}审…`
    )
  })
})
