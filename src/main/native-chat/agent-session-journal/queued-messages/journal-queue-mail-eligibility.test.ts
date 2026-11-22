import { expect, it } from 'vitest'
import { createJournalReducerState } from '../projection/journal-reducer'
import '../projection/journal-reducer-transition'
import '../input-order/journal-queued-row-index'
import './journal-queue-events'
import '../input-order/journal-input-order'
import { nextEligibleQueuedCard } from './journal-queue-mail-eligibility'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { QueuedMessageRow } from './queued-message-table'

function card(index: number, body: AgentJournalMessageItem): QueuedMessageRow {
  return {
    messageId: `card-${index}`,
    position: index,
    body,
    fingerprint: 'body',
    state: 'waiting',
    holdReason: null,
    returnedReason: null,
    returnedRejection: null,
    consumedAs: null,
    queuedAt: { epoch: 'epoch', sequence: 1 },
    unattended: false
  }
}

it("offers Orca's own mail to a running turn, past a person's queued follow-up", () => {
  const state = createJournalReducerState('session', 'epoch')
  const text = (value: string) => [{ type: 'text' as const, text: value }]
  state.queue.cards.set('card-1', card(1, { kind: 'message', role: 'user', blocks: text('later') }))
  state.queue.cards.set(
    'card-2',
    card(2, {
      kind: 'message',
      role: 'user',
      blocks: text('Your owner changed item 4'),
      from: {
        kind: 'agent',
        senders: [],
        orchestration: {
          message: 'mail-notice',
          mailbox: 'orca_session_id:chat',
          dispatchId: null,
          messages: [{ messageId: 'msg_item_e11', runId: '', from: 'orca:items' }]
        }
      }
    })
  )

  const steered = nextEligibleQueuedCard({
    state,
    floor: null,
    get: (id) => state.queue.cards.get(id) ?? null,
    editHeld: () => false,
    revisions: [],
    unavailable: undefined,
    steer: true
  })

  expect(steered?.messageId).toBe('card-2')
})
