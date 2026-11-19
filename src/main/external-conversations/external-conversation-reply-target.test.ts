import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { replyTargetOf } from './external-conversation-types'

// Design item 125 §2 and F3: an agent's own reply names the request its running turn answers, by
// that turn's opener's stamp, only for that opener's own conversation.

const link: ExternalConversationLink = {
  source: 'slack',
  externalId: 'slack:T1:C1:1.2',
  sessionId: 'chat-1',
  agent: 'claude',
  paneKey: 'pane-1',
  createdAt: 1
}
const opener = (externalId: string): AgentJournalRenderItem => ({
  itemId: 'opener',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'review' }],
    connectorDelivery: {
      account: 'account-a',
      conversation: { source: 'slack', externalId },
      deliveryId: 'd1'
    }
  }
})

it('names the running turn’s request for its own conversation', () => {
  const target = replyTargetOf(
    { link, workspace: { worktreeId: 'w' } },
    100,
    opener(link.externalId)
  )
  expect(target.answerDeliveryId).toBe('d1')
})

it('names none when the turn was opened by another conversation, or by no delivery', () => {
  expect(
    replyTargetOf({ link, workspace: { worktreeId: 'w' } }, 100, opener('slack:T1:C2:9.9'))
      .answerDeliveryId
  ).toBeUndefined()
  expect(
    replyTargetOf({ link, workspace: { worktreeId: 'w' } }, 100, null).answerDeliveryId
  ).toBeUndefined()
})
