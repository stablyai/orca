import { afterEach, describe, expect, it } from 'vitest'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalApprovalItem } from '../../../shared/agent-session-journal-types'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  providerItemId,
  providerTurnItemId,
  runningTool
} from './provider-timeline-assembler-test-support'

afterEach(closeProviderTimelineRigs)

const approval: AgentJournalApprovalItem = {
  kind: 'approval',
  title: 'Run npm test?',
  detail: null,
  options: [
    { id: 'allow', label: 'Allow' },
    { id: 'reject', label: 'Reject' }
  ],
  resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
}

describe('provider timeline session end', () => {
  it('ends the open turn interrupted with no verdict when the child exit was observed', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({ type: 'item.open', item: 'call-a', body: runningTool('read') })
    rig.assembler.apply({
      type: 'text.delta',
      item: { stream: 'reply' },
      channel: 'assistant',
      text: 'Half'
    })
    rig.assembler.apply({ type: 'request.open', request: 'perm-1', body: approval })
    rig.assembler.apply({
      type: 'session.ended',
      verdict: { state: 'interrupted', completedAt: 4_000 }
    })

    const turn = await rig.turn('turn-1')
    expect(turn).toMatchObject({ state: 'interrupted', completedAt: 4_000, startedAt: 1_000 })
    expect(turn).not.toHaveProperty('outcome')
    expect((await rig.row(providerItemId('item', 'call-a')))?.body).toMatchObject({
      state: 'failed',
      endedAs: 'interrupted'
    })
    expect((await rig.row(providerItemId('request', 'perm-1')))?.body).toMatchObject({
      resolution: { state: 'cancelled', selectedOptionId: null }
    })
    // A stream cut off keeps the text it received.
    const messages = (await rig.rows()).filter((row) => row.body.kind === 'message')
    expect(messages.map((row) => row.body)).toEqual([
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Half' }] }
    ])
  })

  it('marks the open turn unverifiable with no end when the host lost the child', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'input.accepted', clientMessageId: 'send-1', requestedAt: 900 })
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({ type: 'session.ended', verdict: { state: 'unverifiable' } })
    const turn = await rig.turn('turn-1')
    expect(turn).toMatchObject({ state: 'unverifiable', startedAt: 1_000, requestedAt: 900 })
    expect(turn).not.toHaveProperty('completedAt')
    expect(turn).not.toHaveProperty('durationMs')
    expect(turn).not.toHaveProperty('outcome')
  })

  it('drops everything after the session ended', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', at: 1_000 })
    const first = rig.assembler.openTurnId
    rig.assembler.apply({
      type: 'session.ended',
      verdict: { state: 'interrupted', completedAt: 2_000 }
    })
    // A straggler from the dead child must not open a turn nothing would close.
    expect(rig.assembler.apply({ type: 'turn.open', at: 2_500 }).dropped).toBe('session-ended')
    expect(
      rig.assembler.apply({ type: 'item.open', item: 'call-a', body: runningTool('read') }).dropped
    ).toBe('session-ended')
    expect(rig.assembler.openTurnId).toBeNull()
    const turns = (await rig.rows()).filter((row) => row.body.kind === 'turn')
    expect(turns.map((row) => row.body)).toEqual([
      expect.objectContaining({ turnId: first, state: 'interrupted' })
    ])
  })
})

describe('provider timeline requests', () => {
  it('cancels a request its turn left pending', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({ type: 'request.open', request: 'perm-1', body: approval })
    expect(
      rig.assembler.apply({ type: 'request.open', request: 'perm-1', body: approval }).dropped
    ).toBe('request-duplicate')
    rig.assembler.apply({
      type: 'turn.end',
      at: 2_000,
      state: 'interrupted',
      outcome: 'cancellation'
    })
    const row = await rig.row(providerItemId('request', 'perm-1'))
    expect(row?.body).toMatchObject({ resolution: { state: 'cancelled' } })
    expect(row?.turnScope).toEqual({ kind: 'turn', turnItemId: providerTurnItemId('turn-1') })
  })

  it('never cancels a request a client already answered', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({ type: 'request.open', request: 'perm-1', body: approval })
    const itemId = providerItemId('request', 'perm-1')
    const identity = parseAgentJournalItemKey(itemId)
    if (!identity) {
      throw new Error('request key did not parse')
    }
    // The answer path's compare-and-set wins on another device and writes the row resolved.
    rig.journal.appendItem(
      identity,
      {
        ...approval,
        resolution: {
          state: 'resolved',
          selectedOptionId: 'allow',
          resolvedBy: 'phone',
          resolvedAt: 1_500
        }
      },
      { fence: 1, turnScope: { kind: 'turn', turnItemId: providerTurnItemId('turn-1') } }
    )
    rig.assembler.apply({ type: 'turn.end', at: 2_000, state: 'completed', outcome: 'success' })
    expect((await rig.row(itemId))?.body).toMatchObject({
      resolution: { state: 'resolved', selectedOptionId: 'allow', resolvedBy: 'phone' }
    })
  })

  it('cancels a request the provider withdrew, once', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({ type: 'request.open', request: 'perm-1', body: approval })
    rig.assembler.apply({ type: 'request.withdrawn', request: 'perm-1' })
    // The journal holds the row it withdrew: a repeat is admitted and finds nothing pending.
    expect(rig.assembler.apply({ type: 'request.withdrawn', request: 'perm-1' })).toEqual({
      admission: { accepted: true }
    })
    expect(rig.assembler.apply({ type: 'request.withdrawn', request: 'perm-9' }).dropped).toBe(
      'request-unknown'
    )
    expect((await rig.row(providerItemId('request', 'perm-1')))?.body).toMatchObject({
      resolution: { state: 'cancelled' }
    })
  })
})

describe('provider timeline turn facts', () => {
  it('writes context usage onto the turn that just ended, keeping its end', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({ type: 'turn.end', at: 2_000, state: 'completed', outcome: 'success' })
    rig.assembler.apply({
      type: 'context.usage',
      usage: { window: { tokens: 200_000, capturedAt: 2_100 } }
    })
    expect(await rig.turn('turn-1')).toMatchObject({
      state: 'completed',
      outcome: 'success',
      completedAt: 2_000,
      contextUsage: { window: { tokens: 200_000, capturedAt: 2_100 } }
    })
  })

  it('sets the live activity line only while a turn is open', async () => {
    const rig = await openProviderTimelineRig()
    expect(rig.assembler.apply({ type: 'activity', text: 'Reading' }).dropped).toBe('no-turn')
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    expect(rig.assembler.apply({ type: 'activity', text: 'Reading' }).dropped).toBeUndefined()
  })

  it('journals provider traffic no event covers as the shared fallback row', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({
      type: 'provider.frame',
      frameKind: 'session/mystery_update',
      payload: { message: 'Something new happened' }
    })
    const frame = (await rig.rows()).find((row) => row.body.kind === 'status')
    expect(frame?.body).toMatchObject({ kind: 'status' })
    expect(frame?.turnScope).toEqual({ kind: 'turn', turnItemId: providerTurnItemId('turn-1') })
  })
})
