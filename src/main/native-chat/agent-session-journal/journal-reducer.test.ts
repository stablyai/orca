import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import {
  applyJournalRow,
  createJournalReducerState,
  referencedBlobDigests,
  renderJournalState,
  type JournalReducerState
} from './journal-reducer'
import type { JournalRow } from './journal-row-schema'

const EPOCH = 'epoch-1'

function text(value: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: value }] }
}

function base(seq: number): { v: number; epoch: string; seq: number; fence: number; ts: number } {
  return { v: 1, epoch: EPOCH, seq, fence: 1, ts: 1_000 + seq }
}

function fold(rows: JournalRow[]): JournalReducerState {
  const state = createJournalReducerState('session-1', EPOCH)
  for (const row of rows) {
    applyJournalRow(state, row)
  }
  return state
}

describe('revisions and tombstones', () => {
  it('takes the highest revision', () => {
    const state = fold([
      { kind: 'item', itemId: 'a', revision: 1, body: text('first'), ...base(1) },
      { kind: 'item', itemId: 'a', revision: 2, body: text('second'), ...base(2) }
    ])
    expect(renderJournalState(state).items[0]?.body).toEqual(text('second'))
  })

  it('drops a late lower revision instead of resurrecting stale content', () => {
    const state = fold([
      { kind: 'item', itemId: 'a', revision: 2, body: text('second'), ...base(1) },
      { kind: 'item', itemId: 'a', revision: 1, body: text('first'), ...base(2) }
    ])
    expect(renderJournalState(state).items[0]?.body).toEqual(text('second'))
  })

  it('removes an item on a tombstone', () => {
    const state = fold([
      { kind: 'item', itemId: 'a', revision: 1, body: text('gone'), ...base(1) },
      { kind: 'tombstone', itemId: 'a', revision: 2, ...base(2) }
    ])
    expect(renderJournalState(state).items).toHaveLength(0)
  })

  it('does not let a late lower revision resurrect a tombstoned item', () => {
    const state = fold([
      { kind: 'item', itemId: 'a', revision: 1, body: text('gone'), ...base(1) },
      { kind: 'tombstone', itemId: 'a', revision: 3, ...base(2) },
      { kind: 'item', itemId: 'a', revision: 2, body: text('stale'), ...base(3) }
    ])
    expect(renderJournalState(state).items).toHaveLength(0)
  })

  it('re-creates an item at a revision above the tombstone', () => {
    const state = fold([
      { kind: 'item', itemId: 'a', revision: 1, body: text('gone'), ...base(1) },
      { kind: 'tombstone', itemId: 'a', revision: 2, ...base(2) },
      { kind: 'item', itemId: 'a', revision: 3, body: text('back'), ...base(3) }
    ])
    expect(renderJournalState(state).items.map((item) => item.body)).toEqual([text('back')])
  })
})

describe('ordering', () => {
  it('orders by the sequence that created an item, not by a later revision', () => {
    const state = fold([
      { kind: 'item', itemId: 'a', revision: 1, body: text('a'), ...base(1) },
      { kind: 'item', itemId: 'b', revision: 1, body: text('b'), ...base(2) },
      { kind: 'item', itemId: 'a', revision: 2, body: text('a2'), ...base(3) }
    ])
    expect(renderJournalState(state).items.map((item) => item.itemId)).toEqual(['a', 'b'])
  })

  it('orders by sequence regardless of the order rows are applied in', () => {
    // Live append and replay must render the same list, so the fold cannot lean
    // on the order it happens to be handed rows in.
    const state = fold([
      { kind: 'item', itemId: 'later', revision: 1, body: text('later'), ...base(9) },
      { kind: 'item', itemId: 'earlier', revision: 1, body: text('earlier'), ...base(3) }
    ])
    expect(renderJournalState(state).items.map((item) => item.itemId)).toEqual(['earlier', 'later'])
  })

  it('orders by sequence even when the observed timestamp runs backwards', () => {
    const state = fold([
      { kind: 'item', itemId: 'late', revision: 1, body: text('late'), ...base(1), ts: 9_000 },
      {
        kind: 'item',
        itemId: 'recovered',
        revision: 1,
        body: text('recovered'),
        ...base(2),
        ts: 10,
        recovered: true
      }
    ])
    const items = renderJournalState(state).items
    expect(items.map((item) => item.itemId)).toEqual(['late', 'recovered'])
    expect(items[1]?.recovered).toBe(true)
  })

  it('never collapses two items that carry identical text', () => {
    const state = fold([
      { kind: 'item', itemId: 'a', revision: 1, body: text('run the tests'), ...base(1) },
      { kind: 'item', itemId: 'b', revision: 1, body: text('run the tests'), ...base(2) }
    ])
    expect(renderJournalState(state).items).toHaveLength(2)
  })
})

describe('submission and dispatch state machine', () => {
  const submission: JournalRow = {
    kind: 'submission',
    clientMessageId: 'cm_1',
    payloadFingerprint: 'fp_1',
    providerHandle: { kind: 'codex', threadId: 'thread-1' },
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
    ...base(1)
  }

  it('seeds a pending submission and an optimistic bubble', () => {
    const rendered = renderJournalState(fold([submission]))
    expect(rendered.submissions[0]?.dispatchState).toBe('pending')
    expect(rendered.items.map((item) => item.itemId)).toEqual([agentJournalSubmissionKey('cm_1')])
  })

  it('mints a receipt and adopts the provider item id on accept', () => {
    const state = fold([
      submission,
      {
        kind: 'dispatch',
        clientMessageId: 'cm_1',
        state: 'accepted',
        providerItemId: 'codex:thread-1:turn-1:0',
        reason: null,
        ...base(2)
      }
    ])
    expect(state.receipts.get('cm_1')?.cursor).toEqual({ epoch: EPOCH, sequence: 2 })
    expect(state.submissions.get('cm_1')?.providerItemId).toBe('codex:thread-1:turn-1:0')
  })

  it('folds the provider echo into the submission bubble instead of adding a second one', () => {
    const state = fold([
      submission,
      {
        kind: 'dispatch',
        clientMessageId: 'cm_1',
        state: 'accepted',
        providerItemId: 'codex:thread-1:turn-1:0',
        reason: null,
        ...base(2)
      },
      {
        kind: 'item',
        itemId: 'codex:thread-1:turn-1:0',
        revision: 1,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
        ...base(3)
      }
    ])
    const items = renderJournalState(state).items
    expect(items).toHaveLength(1)
    expect(items[0]?.itemId).toBe(agentJournalSubmissionKey('cm_1'))
    // The echo updates content in place; the bubble keeps its original slot.
    expect(items[0]?.sequence).toBe(1)
    expect(items[0]?.revision).toBe(1)
  })

  it('treats rejected as terminal', () => {
    const state = fold([
      submission,
      {
        kind: 'dispatch',
        clientMessageId: 'cm_1',
        state: 'rejected',
        providerItemId: null,
        reason: 'not_delivered',
        ...base(2)
      },
      {
        kind: 'dispatch',
        clientMessageId: 'cm_1',
        state: 'unknown',
        providerItemId: null,
        reason: 'late',
        ...base(3)
      }
    ])
    expect(state.submissions.get('cm_1')?.dispatchState).toBe('rejected')
    expect(state.submissions.get('cm_1')?.reason).toBe('not_delivered')
  })

  it('lets an unknown submission settle later', () => {
    const state = fold([
      submission,
      {
        kind: 'dispatch',
        clientMessageId: 'cm_1',
        state: 'unknown',
        providerItemId: null,
        reason: 'host_restarted_before_acknowledgement',
        ...base(2)
      },
      {
        kind: 'dispatch',
        clientMessageId: 'cm_1',
        state: 'accepted',
        providerItemId: 'p1',
        reason: null,
        ...base(3)
      }
    ])
    expect(state.submissions.get('cm_1')?.dispatchState).toBe('accepted')
    expect(state.receipts.get('cm_1')).toBeTruthy()
  })

  it('ignores a dispatch for a submission this epoch never saw', () => {
    const state = fold([
      {
        kind: 'dispatch',
        clientMessageId: 'ghost',
        state: 'accepted',
        providerItemId: 'p',
        reason: null,
        ...base(1)
      }
    ])
    expect(state.submissions.size).toBe(0)
    expect(state.receipts.size).toBe(0)
  })
})

describe('blob retention', () => {
  it('reports the digests live rows still reference', () => {
    const state = fold([
      {
        kind: 'item',
        itemId: 'tool',
        revision: 1,
        body: {
          kind: 'tool-call',
          name: 'bash',
          input: {},
          state: 'completed',
          output: { head: 'x', byteLength: 999, digest: 'digest-a', truncated: true }
        },
        ...base(1)
      },
      {
        kind: 'item',
        itemId: 'inline',
        revision: 1,
        body: {
          kind: 'tool-call',
          name: 'bash',
          input: {},
          state: 'completed',
          output: { head: 'y', byteLength: 1, digest: 'digest-b', truncated: false }
        },
        ...base(2)
      }
    ])
    expect([...referencedBlobDigests(state)]).toEqual(['digest-a'])
  })

  it('stops referencing a digest once its item is tombstoned', () => {
    const state = fold([
      {
        kind: 'item',
        itemId: 'tool',
        revision: 1,
        body: {
          kind: 'diff',
          path: 'a.ts',
          patch: { head: 'x', byteLength: 999, digest: 'digest-a', truncated: true }
        },
        ...base(1)
      },
      { kind: 'tombstone', itemId: 'tool', revision: 2, ...base(2) }
    ])
    expect(referencedBlobDigests(state).size).toBe(0)
  })
})
