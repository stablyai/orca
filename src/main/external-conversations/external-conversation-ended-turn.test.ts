import { expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { ConversationChat } from './external-conversation-chat'
import { endedTurn } from './external-conversation-ended-turn'

// Design item 125 §3 (turn membership): an ended turn's deliveries are its opener's and each send the
// provider proved it steered in, keyed by the turn row's journal key rather than the provider's
// turn id. A message whose turn scope only the host set at handover is not evidence. Its prose is
// the turn's own.

const TURN_KEY = 'item:turn-1'
const SLACK = { source: 'slack', externalId: 'slack:T1:C1:1.2' }

const item = (
  itemId: string,
  sequence: number,
  body: AgentJournalRenderItem['body'],
  turnItemId?: string
): AgentJournalRenderItem => ({
  itemId,
  revision: 1,
  body,
  sequence,
  observedAt: sequence,
  ...(turnItemId ? { turnScope: { kind: 'turn' as const, turnItemId } } : {})
})
const asked = (deliveryId: string, sequence: number, turnItemId?: string) =>
  item(
    agentJournalSubmissionKey(deliveryId),
    sequence,
    {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: deliveryId }],
      connectorDelivery: { account: 'account-a', conversation: SLACK, deliveryId }
    },
    turnItemId
  )
const steered: AgentJournalSubmission = {
  clientMessageId: 'd1',
  fence: 1,
  payloadFingerprint: 'd1',
  dispatchState: 'accepted',
  providerItemId: null,
  reason: null,
  submittedAt: 1,
  resolvedAt: 2,
  answeredInTurn: { turnItemId: TURN_KEY, via: 'steer' }
}

it('claims the opener and the proven steer by the turn row’s key, never a host-scoped handover', async () => {
  const items = [
    asked('d0', 1),
    asked('d1', 2),
    // Handed over into the turn by the host; the provider never took it.
    asked('d2', 3, TURN_KEY),
    item(
      'said',
      4,
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Done.' }] },
      TURN_KEY
    ),
    asked('after', 5),
    item(TURN_KEY, 6, {
      kind: 'turn',
      turnId: 'provider-turn-1',
      state: 'completed',
      outcome: 'success',
      userItemId: agentJournalSubmissionKey('d0')
    })
  ]
  const chat = {
    journalReads: async () => ({
      operationWindow: async () => ({
        snapshot: {
          sessionId: 'chat-1',
          cursor: { epoch: 'e', sequence: 6 },
          items,
          submissions: [steered]
        },
        complete: true
      }),
      canonicalItemIds: async (ids: readonly string[]) =>
        ids.map((itemId) => ({ itemId, canonicalItemId: itemId }))
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: endedTurn reads only these chat members.
  const ended = await endedTurn(chat as unknown as ConversationChat, 'chat-1', 'provider-turn-1', {
    epoch: 'e',
    sequence: 6
  })
  expect(ended.turnItemId).toBe(TURN_KEY)
  expect(ended.stamps?.map((stamp) => stamp.deliveryId).sort()).toEqual(['d0', 'd1'])
  expect(ended.turnProse).toBe('Done.')
})
