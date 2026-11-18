import { describe, expect, it } from 'vitest'
import { makeTestBot } from './bot.test-fixture'
import { botOtherAskers } from '../../shared/google/google-who-can-ask-warning'

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
})
