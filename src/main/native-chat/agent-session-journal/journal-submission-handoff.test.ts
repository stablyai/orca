import { expect, it } from 'vitest'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'

it('requires original handover scope or an exact opener, rather than reduced positional scope', () => {
  const state = createJournalReducerState('session', 'epoch')
  const base = (seq: number) => ({ v: 1, epoch: 'epoch', seq, fence: 1, ts: seq })
  applyJournalRow(state, {
    ...base(1),
    kind: 'item',
    itemId: 'turn',
    revision: 1,
    body: { kind: 'turn', turnId: 'turn-1', state: 'running' }
  })
  applyJournalRow(state, {
    ...base(2),
    kind: 'submission',
    clientMessageId: 'notice',
    payloadFingerprint: 'fingerprint',
    providerHandle: { kind: 'codex', threadId: 'thread' },
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'notice' }] }
  })
  expect(state.mailHandoffs.owner(state, 'notice')).toBeNull()
  applyJournalRow(state, {
    ...base(3),
    kind: 'dispatch',
    clientMessageId: 'notice',
    state: 'pending',
    providerItemId: null,
    reason: null,
    turnScope: { kind: 'turn', turnItemId: 'turn' }
  })
  applyJournalRow(state, {
    ...base(4),
    kind: 'dispatch',
    clientMessageId: 'notice',
    state: 'accepted',
    providerItemId: null,
    reason: null
  })
  expect(state.mailHandoffs.owner(state, 'notice')).toMatchObject({ itemId: 'turn' })
  applyJournalRow(state, {
    ...base(5),
    kind: 'item',
    itemId: 'unrelated',
    revision: 1,
    body: { kind: 'turn', turnId: 'turn-2', state: 'completed', outcome: 'failure' }
  })
  expect(state.mailHandoffs.owner(state, 'notice')).toMatchObject({ itemId: 'turn' })
})
