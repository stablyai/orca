// Admit before sink binding, then sweep the old generation before deferred writes resolve.

import { afterEach, describe, expect, it } from 'vitest'
import { settleStaleStructuredAgentSessionState } from '../agent-session-wire/structured-agent-session-dead-generation-settlement'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  openUnboundProviderTimelineAssembler,
  pendingApproval,
  providerItemId,
  providerTurnItemId,
  runningTool,
  SESSION
} from './provider-timeline-assembler-test-support'

afterEach(closeProviderTimelineRigs)

describe('a resumed session', () => {
  it('decides events admitted before bind against the journal the sweep left', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'old', at: 1_000 })
    rig.assembler.apply({ type: 'item.open', item: 'call-a', body: runningTool('read') })
    rig.assembler.apply({ type: 'request.open', request: '0', body: pendingApproval })
    await rig.rows()

    const { assembler, bind } = openUnboundProviderTimelineAssembler(rig.journal, {
      generation: 'gen-2'
    })
    const late = { type: 'item.update', item: 'call-a', body: runningTool('read') } as const
    assembler.apply({ ...late, join: { turn: 'old' } })
    assembler.apply({
      type: 'item.open',
      item: 'call-b',
      body: runningTool('grep'),
      join: { turn: 'old' }
    })
    assembler.apply({ type: 'turn.open', turn: 'new', at: 3_000 })
    assembler.apply({ type: 'request.open', request: '0', body: pendingApproval })
    await settleStaleStructuredAgentSessionState({
      journal: rig.journal,
      sessionId: SESSION,
      fence: 1,
      acquisitionGeneration: 'gen-2',
      deathEvidence: null
    })
    await bind()

    expect((await rig.turn('old'))?.state).not.toBe('running')
    expect((await rig.row(providerItemId('item', 'call-a')))?.body).toMatchObject({
      state: 'failed'
    })
    // New work must not join swept turns: nothing would settle it.
    expect(await rig.row(providerItemId('item', 'call-b'))).toBeUndefined()
    expect((await rig.row(providerItemId('request', '0')))?.body).toMatchObject({
      resolution: { state: 'cancelled' }
    })
    expect(await rig.turn('new')).toMatchObject({ state: 'running', startedAt: 3_000 })
    expect(await rig.row(providerItemId('request', '0', { generation: 'gen-2' }))).toMatchObject({
      body: { resolution: { state: 'pending' } },
      turnScope: { kind: 'turn', turnItemId: providerTurnItemId('new') }
    })
  })
})
