import { expect, it, vi } from 'vitest'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { journalInputOrder } from './journal-input-order'
import { isolateJournalTransition } from './journal-reducer-transition'
import { failedQueueTurnSequence } from './queued-message-pause'
import type { JournalRow } from './journal-row-schema'

it.each([100, 1_000])(
  'checks failed-turn queue state without scanning %s history items',
  (size) => {
    const state = createJournalReducerState('session', 'epoch')
    const base = (seq: number) => ({ v: 4, epoch: 'epoch', seq, ts: seq, fence: 1 })
    for (let n = 1; n <= size; n++) {
      applyJournalRow(state, {
        ...base(n),
        kind: 'item',
        itemId: `message-${n}`,
        revision: 1,
        body: { kind: 'message', role: 'assistant', blocks: [] }
      })
    }
    const turn: JournalRow = {
      ...base(size + 1),
      kind: 'item',
      itemId: 'turn',
      revision: 1,
      body: { kind: 'turn', turnId: 'turn', state: 'running' }
    }
    applyJournalRow(state, turn)
    const order = journalInputOrder(state)
    expect(order.newestTurn.read()?.itemId).toBe('turn')
    // Drafts read the live map through keys(), so count every way of walking it.
    const walks = (['keys', 'values', 'entries', 'forEach', Symbol.iterator] as const).map(
      (method) => vi.spyOn(state.items, method)
    )
    const failed: JournalRow = {
      ...turn,
      ...base(size + 2),
      revision: 2,
      body: { kind: 'turn', turnId: 'turn', state: 'completed', outcome: 'failure' }
    }
    const pending = isolateJournalTransition(state, (draft) => applyJournalRow(draft, failed))
    expect(failedQueueTurnSequence(order.newestTurn.failure(), 0)).toBe(0)
    const committed = pending.adopt()
    for (let n = 0; n < 10; n++) {
      const owner = journalInputOrder(committed)
      expect(failedQueueTurnSequence(owner.newestTurn.failure(), 0)).toBe(size + 2)
      expect(owner.head(committed, null)).toBeUndefined()
    }
    for (const walk of walks) {
      expect(walk).not.toHaveBeenCalled()
      walk.mockRestore()
    }
    applyJournalRow(committed, {
      ...base(size + 3),
      kind: 'tombstone',
      itemId: 'turn',
      revision: 3
    })
    expect(journalInputOrder(committed).newestTurn.read()).toBeNull()
  }
)
