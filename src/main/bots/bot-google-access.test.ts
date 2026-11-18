import { describe, expect, it } from 'vitest'
import { makeTestBot } from './bot.test-fixture'
import { botGoogleRefusal } from './bot-google-access'
import {
  botOtherAskers,
  googleWhoCanAskWarning
} from '../../shared/google/google-who-can-ask-warning'

describe('which runs may use Google', () => {
  it('lets anything outside a bot’s chat through: that is the owner', () => {
    expect(botGoogleRefusal(null)).toBeNull()
  })

  it('is off for a bot until its owner turns it on, then follows the bot like gh and Linear', () => {
    expect(botGoogleRefusal({ name: 'Scout', google: false })).toContain('Google is off for Scout')
    expect(botGoogleRefusal({ name: 'Scout', google: true })).toBeNull()
  })
})

describe('the Who can ask warning for Google', () => {
  it('deduplicates the names of people who can ask the bot', () => {
    const bot = makeTestBot({
      members: [
        { id: 'U1', name: 'Carol', source: 'slack' },
        { id: 'jj', name: 'Carol', source: 'linear', workspaceId: 'w' },
        { id: 'U2', name: 'Nora', source: 'slack' }
      ]
    })
    expect(botOtherAskers(bot)).toEqual(['Carol', 'Nora'])
  })

  it('says nothing when only the owner can ask', () => {
    expect(googleWhoCanAskWarning('Scout', botOtherAskers(makeTestBot({ members: [] })))).toBeNull()
  })
})
