// A new provider child is a new assembler. Its events can be admitted before its sink binds, and
// the dead-generation sweep for the previous child lands before they are written, so every write
// decides from the journal the sweep left.

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

    // The next child's events are admitted while its sink is unbound.
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
    // The sweep for the dead child lands before the drain.
    await settleStaleStructuredAgentSessionState({
      journal: rig.journal,
      sessionId: SESSION,
      fence: 1,
      acquisitionGeneration: 'gen-2',
      deathEvidence: null
    })
    await bind()

    expect((await rig.turn('old'))?.state).not.toBe('running')
    // The swept tool is not relit by a running report that was admitted before the sweep.
    expect((await rig.row(providerItemId('item', 'call-a')))?.body).toMatchObject({
      state: 'failed'
    })
    // Nor does new running work land in a turn the sweep ended: nothing would ever settle it.
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
