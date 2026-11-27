import { expect, it } from 'vitest'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { EndedChatTurn } from './external-conversation-ended-turn'
import { legacyTurnWords } from './external-conversation-turn-ends'

it('posts a legacy Slack answer only for the owner’s confirmed DM', () => {
  const conversation = { source: 'slack' as const, externalId: 'T0TEAM:D0OWNER:D0OWNER:U0BOT' }
  const link: ExternalConversationLink = {
    ...conversation,
    sessionId: 'chat-1',
    agent: 'claude',
    paneKey: 'pane',
    bot: { kind: 'bot-chat', botId: 'bot-1' },
    createdAt: 0
  }
  const opener = {
    itemId: 'owner-dm',
    revision: 0,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Please fix this and report back.' }],
      origin: 'connector',
      asker: {
        source: 'slack',
        userId: 'U0OWNER',
        role: 'owner',
        place: { kind: 'direct_message', id: 'D0OWNER' }
      },
      connectorConversation: conversation
    }
  } satisfies NonNullable<EndedChatTurn['opener']>
  const turn = { lastAssistantMessage: 'I started the fix.\n\nNO_REPLY', opener, stamps: [] }
  const withOpener = (body: NonNullable<EndedChatTurn['opener']>['body']) => ({
    ...turn,
    opener: { ...opener, body }
  })
  const { origin: _origin, ...localBody } = opener.body
  const member = withOpener({ ...opener.body, asker: { ...opener.body.asker, role: 'member' } })
  const differentDm = { ...conversation, externalId: 'T0TEAM:D0OTHER:D0OTHER:U0BOT' }
  const channel = { ...conversation, externalId: 'T0TEAM:C0CHANNEL:1.0:U0BOT' }

  expect({
    ownerDm: legacyTurnWords(turn, link, 'not-covered', undefined),
    member: legacyTurnWords(member, link, 'not-covered', undefined),
    differentDm: legacyTurnWords(turn, { ...link, ...differentDm }, 'not-covered', undefined),
    orcaOpener: legacyTurnWords(withOpener(localBody), link, 'not-covered', undefined),
    positionalOpener: legacyTurnWords(
      { ...turn, opener: null, latestOpener: opener },
      link,
      'not-covered',
      undefined
    ),
    channel: legacyTurnWords(
      withOpener({ ...opener.body, connectorConversation: channel }),
      { ...link, ...channel },
      'not-covered',
      undefined
    ),
    possibleOutboxReply: legacyTurnWords(turn, link, 'unsafe', undefined)
  }).toEqual({
    ownerDm: 'I started the fix.',
    member: null,
    differentDm: null,
    orcaOpener: null,
    positionalOpener: null,
    channel: null,
    possibleOutboxReply: null
  })
})
