import { expect, it } from 'vitest'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { buildJournalItemRow } from './journal-row-builders'
import { planJournalLifecycleRows } from './journal-lifecycle-plan'
import type { JournalLifecycleMutationInput } from './journal-lifecycle-mutation'
import {
  serializeJournalRow,
  parseJournalRow,
  MAX_JOURNAL_LIFECYCLE_BATCH_BYTES
} from './journal-row-schema'

const identity = { provider: 'orca' as const, clientMessageId: 'B' }
const scope = { kind: 'thread' as const }
function fixture() {
  const state = createJournalReducerState('session', '00000000-0000-4000-8000-000000000000')
  applyJournalRow(
    state,
    buildJournalItemRow({
      state,
      identity,
      body: { kind: 'turn', turnId: 'B', state: 'running' },
      turnScope: scope,
      seq: 1,
      ts: 1,
      fence: 0
    })
  )
  return state
}

it.each([0, 199])(
  'preserves provider birth then exact old settlement across %s fillers',
  (fillers) => {
    const state = fixture()
    const mutations: JournalLifecycleMutationInput[] = [
      {
        kind: 'item',
        identity,
        body: { kind: 'turn', turnId: 'B', state: 'running' },
        executionOwner: 1,
        turnScope: scope
      },
      ...Array.from({ length: fillers }, (_, i): JournalLifecycleMutationInput => ({
        kind: 'item',
        identity: { provider: 'orca', clientMessageId: `filler-${i}` },
        body: { kind: 'status', text: 'filler' },
        turnScope: scope
      })),
      {
        kind: 'item',
        itemId: 'orca:B',
        body: { kind: 'turn', turnId: 'B', state: 'interrupted' },
        turnScope: scope
      }
    ]
    const rows = planJournalLifecycleRows(
      state,
      { settlementId: 'mixed', fence: 1 },
      mutations,
      2,
      2,
      undefined,
      true
    )
    expect(state.items.get('orca:B')?.body).toMatchObject({ state: 'running' })
    for (const row of rows) {
      const parsed = parseJournalRow(serializeJournalRow(row))
      if (!parsed.ok) {
        throw new Error('invalid planned row')
      }
      applyJournalRow(state, parsed.row)
    }
    const fresh = state.aliases.get('orca:B')
    expect(fresh).toBeDefined()
    expect(fresh).not.toBe('orca:B')
    expect(state.items.get(fresh!)?.body).toMatchObject({ state: 'running' })
    expect(state.items.get('orca:B')?.body).toMatchObject({ state: 'interrupted' })
  }
)

it('writes nothing for an all-stale exact settlement', () => {
  const state = fixture()
  applyJournalRow(state, {
    kind: 'tombstone',
    v: 2,
    epoch: state.epoch,
    seq: 2,
    ts: 2,
    fence: 0,
    itemId: 'orca:B',
    revision: 2
  })
  const rows = planJournalLifecycleRows(
    state,
    { settlementId: 'stale', fence: 1 },
    [
      {
        kind: 'item',
        itemId: 'orca:B',
        body: { kind: 'turn', turnId: 'B', state: 'interrupted' },
        turnScope: scope
      }
    ],
    3,
    3
  )
  expect(rows).toEqual([])
  expect(state.lastSequence).toBe(2)
})

it('preserves execution ownership in an oversized fallback row', () => {
  const state = fixture()
  const rows = planJournalLifecycleRows(
    state,
    { settlementId: 'large', fence: 1 },
    [
      {
        kind: 'item',
        identity: { provider: 'orca', clientMessageId: 'large' },
        body: {
          kind: 'tool-call',
          name: 'shell',
          input: { command: 'x'.repeat(MAX_JOURNAL_LIFECYCLE_BATCH_BYTES) },
          state: 'failed'
        },
        executionOwner: 17,
        ownerFence: 4,
        turnScope: scope
      }
    ],
    2,
    2
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ kind: 'item', executionOwner: 17, ownerFence: 4 })
  expect(parseJournalRow(serializeJournalRow(rows[0])).ok).toBe(true)
})
