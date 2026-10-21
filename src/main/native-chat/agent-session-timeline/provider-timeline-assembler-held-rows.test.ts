import { afterEach, describe, expect, it } from 'vitest'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  pendingApproval,
  providerItemId,
  providerTurnItemId,
  runningTool
} from './provider-timeline-assembler-test-support'

afterEach(closeProviderTimelineRigs)

const answered = {
  ...pendingApproval,
  resolution: {
    state: 'resolved' as const,
    selectedOptionId: 'allow',
    resolvedBy: 'phone',
    resolvedAt: 1_500
  }
}

describe('what the journal already holds stands', () => {
  it('settles at the session end the work the journal holds open, from its rows', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({ type: 'item.open', item: 'tool', body: runningTool('read') })
    const identity = parseAgentJournalItemKey(providerItemId('item', 'done'))
    if (!identity) {
      throw new Error('item key did not parse')
    }
    // Another writer settled one row in the turn; the session end settles only what is still open.
    await rig.journal.appendItem(
      identity,
      { ...runningTool('grep'), state: 'completed' },
      { fence: 1, turnScope: { kind: 'turn', turnItemId: providerTurnItemId('t1') } }
    )
    rig.assembler.apply({
      type: 'session.ended',
      verdict: { state: 'interrupted', completedAt: 2_000 }
    })
    expect(await rig.turn('t1')).toMatchObject({ state: 'interrupted', completedAt: 2_000 })
    expect((await rig.row(providerItemId('item', 'tool')))?.body).toMatchObject({ state: 'failed' })
    expect((await rig.row(providerItemId('item', 'done')))?.body).toMatchObject({
      state: 'completed'
    })
  })

  it('never resurrects a settled tool from a running snapshot', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({
      type: 'item.close',
      item: 'tool',
      body: { ...runningTool('read'), state: 'completed' }
    })
    expect(
      rig.assembler.apply({ type: 'item.update', item: 'tool', body: runningTool('read') }).dropped
    ).toBe('item-settled')
    rig.assembler.apply({
      type: 'session.ended',
      verdict: { state: 'interrupted', completedAt: 2_000 }
    })
    expect((await rig.row(providerItemId('item', 'tool')))?.body).toMatchObject({
      state: 'completed'
    })
  })
})

describe('requests', () => {
  it('opens a request reused after it settled as a new one, and withdraws each on its own', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({ type: 'request.open', request: 'p1', body: pendingApproval })
    rig.assembler.apply({ type: 'request.withdrawn', request: 'p1' })
    await rig.rows()
    rig.assembler.apply({ type: 'request.open', request: 'p1', body: pendingApproval })
    rig.assembler.apply({ type: 'request.withdrawn', request: 'p1' })

    const prompts = (await rig.rows()).filter((row) => row.body.kind === 'approval')
    expect(prompts.map((row) => row.itemId)).toEqual([
      providerItemId('request', 'p1'),
      providerItemId('request', 'p1', { incarnation: 2 })
    ])
    expect(prompts.map((row) => row.body)).toEqual([
      expect.objectContaining({ resolution: expect.objectContaining({ state: 'cancelled' }) }),
      expect.objectContaining({ resolution: expect.objectContaining({ state: 'cancelled' }) })
    ])
  })

  it('opens a new request when the pending one under its key was answered', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({ type: 'request.open', request: 'p1', body: pendingApproval })
    const identity = parseAgentJournalItemKey(providerItemId('request', 'p1'))
    if (!identity) {
      throw new Error('request key did not parse')
    }
    await rig.journal.appendItem(identity, answered, {
      fence: 1,
      turnScope: { kind: 'turn', turnItemId: providerTurnItemId('t1') }
    })
    expect(
      rig.assembler.apply({ type: 'request.open', request: 'p1', body: pendingApproval }).dropped
    ).toBeUndefined()
    // The answered prompt keeps its answer; withdrawing reaches only the new one.
    rig.assembler.apply({ type: 'request.withdrawn', request: 'p1' })
    expect((await rig.row(providerItemId('request', 'p1')))?.body).toMatchObject({
      resolution: { state: 'resolved' }
    })
    expect(
      (await rig.row(providerItemId('request', 'p1', { incarnation: 2 })))?.body
    ).toMatchObject({
      resolution: { state: 'cancelled' }
    })
  })

  it('leaves an answered request answered when its withdrawal lands after the answer', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({ type: 'request.open', request: 'p1', body: pendingApproval })
    const identity = parseAgentJournalItemKey(providerItemId('request', 'p1'))
    if (!identity) {
      throw new Error('request key did not parse')
    }
    // Memory still holds it pending; only the journal knows a client answered.
    await rig.journal.appendItem(identity, answered, {
      fence: 1,
      turnScope: { kind: 'turn', turnItemId: providerTurnItemId('t1') }
    })
    rig.assembler.apply({ type: 'request.withdrawn', request: 'p1' })
    expect((await rig.row(providerItemId('request', 'p1')))?.body).toMatchObject({
      resolution: { state: 'resolved', selectedOptionId: 'allow' }
    })
  })

  it('never overwrites a request row already in the journal when its open runs', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({ type: 'request.open', request: 'p1', body: pendingApproval })
    const identity = parseAgentJournalItemKey(providerItemId('request', 'p1'))
    if (!identity) {
      throw new Error('request key did not parse')
    }
    await rig.journal.appendItem(identity, answered, {
      fence: 1,
      turnScope: { kind: 'turn', turnItemId: providerTurnItemId('t1') }
    })
    // Another assembler of the same generation, blind to the journal, opens `p1` again.
    const blind = rig.assemble({ sink: { ...rig.sink, journalItems: () => null } })
    blind.apply({ type: 'request.open', request: 'p1', body: pendingApproval })
    expect((await rig.row(providerItemId('request', 'p1')))?.body).toMatchObject({
      resolution: { state: 'resolved', selectedOptionId: 'allow' }
    })
    expect(
      (await rig.row(providerItemId('request', 'p1', { incarnation: 2 })))?.body
    ).toMatchObject({ resolution: { state: 'pending' } })
  })
})
