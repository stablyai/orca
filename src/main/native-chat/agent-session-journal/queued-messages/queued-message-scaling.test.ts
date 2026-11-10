import { afterEach, expect, it, vi } from 'vitest'
import { createJournalReducerState } from '../projection/journal-reducer'
import '../projection/journal-reducer-transition'
import '../input-order/journal-queued-row-index'
import './journal-queue-events'
import { QueuedMessageEditLeases } from './queued-message-edit-leases'
import '../input-order/journal-input-order'
import { nextEligibleQueuedCard } from './journal-queue-mail-eligibility'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { QueuedMessageRow } from './queued-message-table'

const body: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'follow up' }]
}
function card(index: number, state: QueuedMessageRow['state'] = 'waiting'): QueuedMessageRow {
  return {
    messageId: `card-${index}`,
    position: index,
    body,
    fingerprint: 'body',
    state,
    holdReason: null,
    returnedReason: null,
    returnedRejection: null,
    consumedAs: null,
    queuedAt: { epoch: 'epoch', sequence: 1 },
    unattended: false
  }
}
afterEach(() => vi.restoreAllMocks())

it('an edit lease on a skipped row bars the tail until its deadline', () => {
  const state = createJournalReducerState('session', 'epoch')
  state.queue.cards.set('card-1', card(1, 'returned'))
  state.queue.cards.set('card-2', card(2))
  state.queue.cards.set('card-3', { ...card(3), deliveryMode: 'steer' })
  state.queuePauseMarks.cleared = { sequence: 2, operationId: 'clear', messageIds: ['card-2'] }
  let now = 0
  const leases = new QueuedMessageEditLeases(
    () => [],
    () => now,
    (id) => state.queue.cards.get(id)
  )
  leases.acquire(
    { callerKey: 'person', editId: 'edit' },
    { messageId: 'card-2', fingerprint: 'body' }
  )
  const claim = () =>
    nextEligibleQueuedCard({
      state,
      floor: null,
      get: (id) => state.queue.cards.get(id) ?? null,
      editHeld: (id) => leases.isHeld(id),
      revisions: [leases.version()],
      unavailable: undefined,
      steer: true
    })
  expect(claim()).toBeNull()
  now = 120_001
  expect(claim()?.messageId).toBe('card-3')
  leases.dispose()
})
