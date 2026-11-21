import { describe, expect, it } from 'vitest'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { linkMirrorsTo } from './external-conversation-reply-recovery-deps'

// Whether a chat's Slack mirror tells its thread a continuation's answer itself (design:
// slack-reply-lost-restart): then reply recovery closes the inherited request quietly. It errs
// toward yes, so the thread never gets the answer twice.

const thread = (fields: Partial<ExternalConversationLink> = {}) =>
  ({
    source: 'slack',
    externalId: 'T05BHT77GUF:C0CGLPJT2NB:1795203312.157709',
    sessionId: 'chat-1',
    bot: { kind: 'bot', botId: 'bot-1' },
    ...fields
  }) as ExternalConversationLink

describe('a continuation the mirror tells', () => {
  it('is mirrored in a thread chat that posts back', () => {
    expect(linkMirrorsTo(thread({ mirror: true, mirrorChosen: true }), ['orca:m1'])).toBe(true)
  })

  it('is mirrored when the mirror already recorded one of its messages, though posting is off now', () => {
    const posted = thread({ mirror: false, mirrorPosts: { 'orca:m1': { state: 'posted', at: 1 } } })
    expect(linkMirrorsTo(posted, ['orca:m1'])).toBe(true)
    expect(linkMirrorsTo(posted, ['orca:m2'])).toBe(false)
  })

  it('is not mirrored in a bot’s Chat, which never posts back', () => {
    expect(
      linkMirrorsTo(thread({ bot: { kind: 'bot-chat', botId: 'bot-1' } as never, mirror: true }), [
        'orca:m1'
      ])
    ).toBe(false)
  })
})
