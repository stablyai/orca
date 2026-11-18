import { describe, expect, it } from 'vitest'
import { makeTestBot } from './bot.test-fixture'
import { botGoogleRefusal, readGoogleRefusal } from './bot-google-access'
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

describe('the calling run', () => {
  const scout = makeTestBot({ id: 'b1', name: 'Scout' })
  const runtime = {
    bots: { enabled: () => true, list: () => [scout] },
    lookAround: {
      botOfLook: (sessionId: string) => (sessionId === 'look' ? 'b1' : null),
      botOfTidyUp: () => null
    }
  }

  it('counts a Look around run as its bot, so Google off is off there too', () => {
    expect(readGoogleRefusal(runtime, 'look', undefined)).toContain('Google is off for Scout')
    expect(readGoogleRefusal(runtime, 'owner-terminal', undefined)).toBeNull()
    // A paired client's session id names nothing on this host.
    expect(readGoogleRefusal(runtime, 'look', 'phone-1')).toBeNull()
  })
})

describe('the Who can ask warning for Google', () => {
  it('names everyone but the owner who can ask the bot, once each', () => {
    const bot = makeTestBot({
      members: [
        { id: 'U1', name: 'Carol', source: 'slack' },
        { id: 'jj', name: 'Carol', source: 'linear', workspaceId: 'w' },
        { id: 'U2', name: 'Nora', source: 'slack' }
      ]
    })
    expect(googleWhoCanAskWarning('Scout', botOtherAskers(bot))).toBe(
      'Carol and Nora will be able to have Scout read and send your email, calendar and files.'
    )
  })

  it('says nothing when only the owner can ask', () => {
    expect(googleWhoCanAskWarning('Scout', botOtherAskers(makeTestBot({ members: [] })))).toBeNull()
  })
})
