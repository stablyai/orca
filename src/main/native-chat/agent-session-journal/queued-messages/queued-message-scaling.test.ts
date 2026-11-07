import { afterEach, expect, it, vi } from 'vitest'
import { createJournalReducerState } from '../projection/journal-reducer'
import { journalInputOrder } from '../input-order/journal-input-order'
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

it.each([1_000, 10_000])('append position does not revisit %i completed queue slots', (size) => {
  const state = createJournalReducerState('session', 'epoch')
  for (let index = 1; index <= size; index++) {
    state.queue.cards.set(`card-${index}`, card(index, 'dispatched'))
  }
  const order = journalInputOrder(state)
  order.cards.ensure(state)
  const values = Map.prototype.values
  let visited = 0
  vi.spyOn(Map.prototype, 'values').mockImplementation(function (this: Map<unknown, unknown>) {
    const iterator = values.call(this)
    const next = iterator.next.bind(iterator)
    iterator.next = (...args) => {
      const value = next(...args)
      if (!value.done) {
        visited++
      }
      return value
    }
    return iterator
  })
  // The append-position trigger needs only the cached bound and the new row, independent of history.
  const next = order.cardBounds(state).last + 1
  order.queueChanged(state, undefined, card(next))
  expect(next).toBe(size + 1)
  expect(order.cardBounds(state).last).toBe(size + 1)
  expect(visited).toBeLessThanOrEqual(2)
})

it.each([1_000, 10_000])('a claim over %i clear-held rows has linear membership work', (size) => {
  const state = createJournalReducerState('session', 'epoch')
  for (let index = 1; index <= size; index++) {
    state.queue.cards.set(`card-${index}`, card(index))
  }
  state.queuePauseMarks.cleared = {
    sequence: 2,
    operationId: 'clear',
    messageIds: [...state.queue.cards.keys()]
  }
  const includes = Array.prototype.includes
  let membershipVisits = 0
  vi.spyOn(Array.prototype, 'includes').mockImplementation(function (
    this: unknown[],
    value: unknown,
    from?: number
  ) {
    if (typeof this[0] === 'string' && this[0].startsWith('card-')) {
      membershipVisits += this.length
    }
    return includes.call(this, value, from)
  })
  const claim = () =>
    nextEligibleQueuedCard({
      state,
      floor: null,
      get: (id) => state.queue.cards.get(id) ?? null,
      editHeld: () => false,
      revisions: [],
      unavailable: undefined
    })
  expect(claim()).toBeNull()
  // One exact-membership population may be read once; testing each row must not reread that population.
  expect(membershipVisits).toBeLessThanOrEqual(size)
  state.queuePauseMarks.resumedSequence = 3
  expect(claim()?.messageId).toBe('card-1')
})
