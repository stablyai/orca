import { expect, it, vi } from 'vitest'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { projectJournalBatch } from '../agent-session-wire/agent-session-journal-batch'
import { carriedJournalQuestionInputs } from './journal-replacement-source'
import { applyJournalRow, createJournalReducerState, renderJournalState } from './journal-reducer'
import { parseJournalRow, type JournalRow } from './journal-row-schema'

const base = { v: 1, epoch: 'epoch', fence: 7, ts: 100 }
const body = {
  kind: 'message' as const,
  role: 'user' as const,
  blocks: [{ type: 'text' as const, text: 'original submitted body' }]
}

it.each([null, '', 'future-role', 0])(
  'treats unusable replayRole %j as unreadable, never as ordinary input',
  (replayRole) => {
    expect(
      parseJournalRow(
        JSON.stringify({
          ...base,
          seq: 1,
          kind: 'item',
          itemId: 'q',
          revision: 1,
          body,
          replayRole
        })
      )
    ).toEqual({ ok: false, unreadable: true })
  }
)

it('keeps source-only submission/dispatch and mixed mutations out of every operational/wire fold', () => {
  const state = createJournalReducerState('session', 'epoch')
  const source: JournalRow[] = [
    {
      ...base,
      seq: 1,
      kind: 'submission',
      clientMessageId: 'send',
      providerHandle: { kind: 'codex', threadId: 'thread' },
      body,
      payloadFingerprint: agentSessionSendBodyFingerprint('session', body),
      replayRole: 'source-only'
    },
    {
      ...base,
      seq: 2,
      kind: 'dispatch',
      clientMessageId: 'send',
      state: 'pending',
      providerItemId: null,
      reason: null,
      replayRole: 'source-only'
    },
    {
      ...base,
      seq: 3,
      kind: 'dispatch',
      clientMessageId: 'send',
      state: 'accepted',
      providerItemId: 'provider-U',
      reason: null,
      replayRole: 'source-only'
    },
    {
      ...base,
      seq: 4,
      kind: 'lifecycle-batch',
      settlementId: 'mixed-original',
      replayRole: 'source-only',
      mutations: [
        {
          kind: 'item',
          itemId: 'old-root',
          revision: 10,
          body: { kind: 'turn', turnId: 'T1', state: 'interrupted', outcome: 'cancellation' }
        },
        { kind: 'tombstone', itemId: 'provider-U', revision: 10 }
      ]
    }
  ]
  source.forEach((row) => applyJournalRow(state, row))
  expect(state.lastSequence).toBe(4)
  expect(state.highestFence).toBe(7)
  expect(state.lastActivityAt).toBe(0)
  expect(state.items.size).toBe(0)
  expect(state.submissions.size).toBe(0)
  expect(state.receipts.size).toBe(0)
  expect(state.aliases.size).toBe(0)
  expect(state.providerActivityAt.size).toBe(0)
  expect(state.appliedSettlementIds.size).toBe(0)
  expect(state.questionSource?.canonicalItemId('provider-U')).toBe(
    agentJournalSubmissionKey('send')
  )
  const inputs = state.questionSource?.inputs.length
  const view: JournalRow = {
    ...base,
    seq: 5,
    kind: 'item',
    itemId: 'provider-U',
    revision: 1,
    body,
    replayRole: 'materialization-only'
  }
  applyJournalRow(state, view)
  expect(state.questionSource?.inputs).toHaveLength(inputs!)
  expect(renderJournalState(state).items.map((item) => item.itemId)).toEqual(['provider-U'])
  const batch = projectJournalBatch({
    rows: [...source, view],
    snapshot: renderJournalState(state),
    afterSequence: 0
  })
  expect(batch).toMatchObject({
    ok: true,
    batch: {
      cursor: { sequence: 5 },
      items: [{ itemId: 'provider-U' }],
      submissions: [],
      removedItemIds: []
    }
  })
  expect(JSON.stringify(batch)).not.toContain('replayRole')
  expect(JSON.stringify(batch)).not.toContain('old-root')
  // A genuine low physical revision follows a carried high revision; source chronology still admits it.
  applyJournalRow(state, {
    ...base,
    seq: 6,
    kind: 'item',
    itemId: 'provider-U',
    revision: 2,
    body: { ...body, blocks: [{ type: 'text', text: 'later live body' }] }
  })
  expect(state.questionSource?.inputs.length).toBeGreaterThan(inputs!)
  expect(renderJournalState(state).items[0].body).toMatchObject({
    blocks: [{ text: 'later live body' }]
  })
})

it.each([10, 100])(
  'indexes factual echo candidates for %i equal-content submissions without history enumeration',
  (count) => {
    const state = createJournalReducerState('session', 'epoch')
    for (let index = 0; index < count; index++) {
      applyJournalRow(state, {
        ...base,
        seq: index + 1,
        kind: 'submission',
        clientMessageId: `send-${index}`,
        providerHandle: { kind: 'codex', threadId: 'thread' },
        body,
        payloadFingerprint: agentSessionSendBodyFingerprint('session', body),
        replayRole: 'source-only'
      })
    }
    const source = state.questionSource
    if (!source) {
      throw new Error('Expected factual source projection')
    }
    const submissions = vi.spyOn(source.state.submissions, 'values')
    const items = vi.spyOn(source.state.items, 'values')
    try {
      for (let index = 0; index < count; index++) {
        const itemId = `codex:thread:turn-${index}:0`
        applyJournalRow(state, {
          ...base,
          seq: count + index + 1,
          kind: 'item',
          itemId,
          revision: 1,
          body,
          replayRole: 'source-only'
        })
        expect(source.canonicalItemId(itemId)).toBe(agentJournalSubmissionKey(`send-${index}`))
      }
      expect(submissions).not.toHaveBeenCalled()
      expect(items).not.toHaveBeenCalled()
      expect(source.inputs).toHaveLength(count * 2)
      expect(state.submissions.size).toBe(0)
      expect(renderJournalState(state).items).toEqual([])
    } finally {
      submissions.mockRestore()
      items.mockRestore()
    }
  }
)

it('retains an accepted equal-body echo as consumed identity across cold source replay', () => {
  const state = createJournalReducerState('session', 'epoch')
  const itemId = 'codex:thread:first:0'
  const rows: JournalRow[] = [
    {
      ...base,
      seq: 1,
      kind: 'submission',
      clientMessageId: 'first',
      providerHandle: { kind: 'codex', threadId: 'thread' },
      body,
      payloadFingerprint: agentSessionSendBodyFingerprint('session', body)
    },
    {
      ...base,
      seq: 2,
      kind: 'dispatch',
      clientMessageId: 'first',
      state: 'accepted',
      providerItemId: itemId,
      reason: null
    },
    { ...base, seq: 3, kind: 'item', itemId, revision: 1, body }
  ]
  rows.forEach((row) => applyJournalRow(state, row))
  const cold = createJournalReducerState('session', 'cold')
  carriedJournalQuestionInputs(state, 'cold', 7).forEach((row) => applyJournalRow(cold, row))
  applyJournalRow(cold, {
    ...base,
    epoch: 'cold',
    seq: cold.lastSequence + 1,
    kind: 'item',
    itemId: 'codex:thread:direct:0',
    revision: 1,
    body,
    replayRole: 'source-only'
  })
  expect(cold.questionSource?.canonicalItemId('codex:thread:direct:0')).toBe(
    'codex:thread:direct:0'
  )
  expect(
    cold.questionSource?.inputs.map((input) =>
      input.kind === 'item' ? input.item.itemId : input.itemId
    )
  ).toEqual([
    agentJournalSubmissionKey('first'),
    agentJournalSubmissionKey('first'),
    agentJournalSubmissionKey('first'),
    'codex:thread:direct:0'
  ])
})
