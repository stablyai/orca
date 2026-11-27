import { describe, expect, it } from 'vitest'
import { botRequestChatTitle, botRequestSenderName } from './bot-request-view'

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

describe('paired senders saved before one field named them', () => {
  it('reads a saved paired server sender as an agent there', () => {
    const saved = { fromBotId: null, fromBotName: null, fromPairedServer: 'Build Box' }
    expect(botRequestSenderName(saved)).toBe('an agent on Build Box')
    expect(botRequestSenderName({ ...saved, fromPairedServer: '' })).toBe(
      'an agent on another computer'
    )
    expect(botRequestChatTitle(saved, 'docs', 'Where is the install guide?')).toBe(
      'an agent on Build Box: Where is the install guide?'
    )
  })

  it('reads a saved paired computer sender, named or not', () => {
    const saved = { fromBotId: null, fromBotName: 'Ranger', fromComputer: 'Review Laptop' }
    expect(botRequestSenderName(saved)).toBe('Ranger on Review Laptop')
    expect(botRequestSenderName({ ...saved, fromBotName: null, fromComputer: null })).toBe(
      'an agent on another computer'
    )
    expect(botRequestChatTitle(saved, 'docs', 'Review the sidebar')).toBe(
      'Ranger on Review Laptop: Review the sidebar'
    )
  })

  it('still reads a local request without a paired computer as before', () => {
    expect(botRequestSenderName({ fromBotName: null })).toBe("your owner's agent")
    expect(botRequestSenderName({ fromBotName: 'Docs' })).toBe('Docs')
  })
})
