import { expect, it } from 'vitest'
import type {
  JournalConnectorReplyFill,
  JournalConnectorReplyRow
} from '../../shared/agent-session/journal/journal-connector-reply'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { conversationReplyFill } from './external-conversation-reply-fill'

const CONVERSATION = { source: 'slack', externalId: 'slack:T1:C1:1.2' }
const stamp = (deliveryId: string) => ({ account: 'a', conversation: CONVERSATION, deliveryId })
const row = (
  deliveryId: string,
  fields: Partial<JournalConnectorReplyRow> = {}
): JournalConnectorReplyRow => ({
  account: 'a',
  deliveryId,
  conversation: CONVERSATION,
  sessionId: 'chat-1',
  epoch: 'e',
  messageId: 'first',
  queued: false,
  ...fields
})

it('fills only the rows its continuation claimed, under the cut group’s own head', async () => {
  const cut = { turnId: 'turn-1', kind: 'restart' as const }
  const fills: JournalConnectorReplyFill[] = []
  const fill = conversationReplyFill(
    () => ({
      read: async () => [
        // The head was answered and sent before the cut: gone from the outbox.
        row('d2', { cut, claimMessageId: 'continue-1' }),
        row('d3', { cut, claimMessageId: 'continue-2' }),
        row('d4', { cut })
      ],
      readOwed: async () => [],
      fillOutcomes: async (batch) => {
        fills.push(...batch)
        return true
      },
      sent: async () => undefined
    }),
    () => undefined
  )
  await fill({
    sessionId: 'chat-1',
    turnItemId: 'item:turn-9',
    stamps: [stamp('d1'), stamp('d2'), stamp('d3'), stamp('d4')],
    openerItemId: agentJournalSubmissionKey('continue-1'),
    outcome: 'success',
    prose: 'Here it is.',
    bot: false,
    links: []
  })
  expect(fills).toEqual([
    expect.objectContaining({
      deliveryId: 'd2',
      answerDeliveryId: 'd1',
      outcome: 'answered',
      expect: { claimMessageId: 'continue-1' }
    })
  ])
})
