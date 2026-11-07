import { afterEach, expect, it, vi } from 'vitest'
import { applyJournalRow, createJournalReducerState } from '../projection/journal-reducer'
import { isolateJournalTransition } from '../projection/journal-reducer-transition'
import { JournalQueuedRowIndex } from '../input-order/journal-queued-row-index'
import { buildJournalQueueRow } from './journal-queue-events'
import { QueuedMessageEditLeases } from './queued-message-edit-leases'
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

it.each([1_000, 10_000])(
  'point writes isolate paths through %i live held rows separately from output',
  (size) => {
    const state = createJournalReducerState('session', 'epoch')
    for (let index = 1; index <= size; index++) {
      state.queue.cards.set(`card-${index}`, card(index))
    }
    state.queuePauseMarks.cleared = {
      sequence: 2,
      operationId: 'clear',
      messageIds: [...state.queue.cards.keys()]
    }
    const order = journalInputOrder(state)
    order.cards.ensure(state)
    const before = order.cards.list()
    const values = JournalQueuedRowIndex.prototype.values
    let outputVisits = 0
    vi.spyOn(JournalQueuedRowIndex.prototype, 'values').mockImplementation(function* (
      this: JournalQueuedRowIndex,
      after
    ) {
      for (const row of values.call(this, after)) {
        outputVisits++
        yield row
      }
    })
    const added = card(size + 1)
    const append = buildJournalQueueRow(
      state,
      added.messageId,
      {
        op: 'queued',
        body,
        position: added.position,
        queuedAt: added.queuedAt,
        unattended: false
      },
      3,
      3
    )
    const transition = isolateJournalTransition(state, (draft) => applyJournalRow(draft, append))
    expect(transition.trackedDerived()).toBeLessThan(450)
    expect(outputVisits).toBe(0)
    expect(order.cards.list()).toBe(before)
    transition.adopt()
    const published = order.cards.list()
    expect(published.length).toBe(size + 1)
    expect(published.at(-1)?.messageId).toBe(added.messageId)
    expect(outputVisits).toBe(size + 1)
    expect(order.cards.list()).toBe(published)
    expect(outputVisits).toBe(size + 1)
    const edit = buildJournalQueueRow(
      state,
      'card-1',
      {
        op: 'edited',
        body: { ...body, blocks: [{ type: 'text', text: 'edited' }] }
      },
      4,
      4
    )
    const abandoned = isolateJournalTransition(state, (draft) => applyJournalRow(draft, edit))
    expect(abandoned.trackedDerived()).toBeLessThan(450)
    expect(order.cards.list()).toBe(published)
    expect(order.cards.head()?.body.blocks).toEqual([{ type: 'text', text: 'follow up' }])
    const committed = isolateJournalTransition(state, (draft) => applyJournalRow(draft, edit))
    committed.adopt()
    expect(order.cards.head()?.body.blocks).toEqual([{ type: 'text', text: 'edited' }])
  }
)

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
  let rowVisits = 0
  const claim = (steer = false, automatic = true) =>
    nextEligibleQueuedCard({
      state,
      floor: null,
      get: (id) => {
        rowVisits++
        return state.queue.cards.get(id) ?? null
      },
      editHeld: () => false,
      revisions: [],
      unavailable: undefined,
      steer,
      automatic
    })
  for (const steer of [false, true]) {
    for (const automatic of [false, true]) {
      expect(claim(steer, automatic)).toBeNull()
    }
  }
  expect(rowVisits).toBe(size * 4)
  for (let repeat = 0; repeat < 4; repeat++) {
    for (const steer of [false, true]) {
      for (const automatic of [false, true]) {
        expect(claim(steer, automatic)).toBeNull()
      }
    }
  }
  expect(rowVisits).toBe(size * 4)
  // One exact-membership population may be read once; testing each row must not reread that population.
  expect(membershipVisits).toBeLessThanOrEqual(size)
  state.queuePauseMarks.resumedSequence = 3
  expect(claim()?.messageId).toBe('card-1')
})

it.each([1_000, 10_000])('available leading mail does not inspect its %i-row tail', (size) => {
  const state = createJournalReducerState('session', 'epoch')
  const mailBody: AgentJournalMessageItem = {
    ...body,
    from: {
      kind: 'agent',
      senders: [],
      orchestration: { message: 'mail-notice', mailbox: 'owner', dispatchId: null, messages: [] }
    }
  }
  for (let index = 1; index <= size; index++) {
    state.queue.cards.set(`card-${index}`, { ...card(index), body: mailBody })
  }
  state.queue.cards.set('card-tail', { ...card(size + 1), messageId: 'card-tail' })
  let unavailable = false
  let visits = 0
  const claim = () =>
    nextEligibleQueuedCard({
      state,
      floor: null,
      get: (id) => {
        visits++
        return state.queue.cards.get(id) ?? null
      },
      editHeld: () => false,
      revisions: [],
      unavailable: () => unavailable
    })
  expect(claim()?.messageId).toBe('card-1')
  expect(claim()?.messageId).toBe('card-1')
  expect(visits).toBe(1)
  unavailable = true
  expect(claim()?.messageId).toBe('card-tail')
  expect(visits).toBe(size + 1)
  expect(claim()?.messageId).toBe('card-tail')
  expect(visits).toBe(size + 1)
  unavailable = false
  expect(claim()?.messageId).toBe('card-1')
})

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
