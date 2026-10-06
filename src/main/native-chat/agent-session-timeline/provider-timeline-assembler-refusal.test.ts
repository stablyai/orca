import { afterEach, describe, expect, it } from 'vitest'
import { MAX_PROVIDER_TIMELINE_OPEN_ENTRIES } from './provider-timeline-budget'
import {
  closeProviderTimelineRigs,
  messageText,
  openProviderTimelineRig,
  pendingApproval,
  providerItemId,
  refusingSink,
  runningTool
} from './provider-timeline-assembler-test-support'

afterEach(closeProviderTimelineRigs)

const BACKPRESSURE = { accepted: false, reason: 'backpressure' }

describe('a refused event changes nothing and its retry lands it once', () => {
  it('settles the tool a refused turn end owed when the end is re-applied', async () => {
    const rig = await openProviderTimelineRig()
    let refusing = false
    const assembler = rig.assemble({ sink: refusingSink(rig.sink, () => refusing) })
    assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    assembler.apply({ type: 'item.open', item: 'tool', body: runningTool('read') })
    refusing = true
    const end = { type: 'turn.end', turn: 't1', at: 2_000, state: 'completed' } as const
    expect(assembler.apply(end).admission).toEqual(BACKPRESSURE)
    expect(assembler.openTurnId).not.toBeNull()

    refusing = false
    expect(assembler.apply(end)).toEqual({ admission: { accepted: true } })
    expect((await rig.row(providerItemId('item', 'tool')))?.body).toMatchObject({ state: 'failed' })
    expect(await rig.turn('t1')).toMatchObject({ state: 'completed', completedAt: 2_000 })
    // A repeated end is admitted and writes nothing: the row keeps its first end.
    expect(assembler.apply(end)).toEqual({ admission: { accepted: true } })
    expect(await rig.turn('t1')).toMatchObject({ state: 'completed', completedAt: 2_000 })
  })

  it('keeps observed text when the close that would write it is refused', async () => {
    const rig = await openProviderTimelineRig()
    let refusing = false
    const assembler = rig.assemble({
      sink: refusingSink(rig.sink, () => refusing),
      schedule: () => () => {}
    })
    assembler.apply({
      type: 'text.delta',
      item: { id: 'm1' },
      channel: 'assistant',
      text: 'Observed text'
    })
    refusing = true
    expect(assembler.apply({ type: 'text.close', item: { id: 'm1' } }).admission).toEqual(
      BACKPRESSURE
    )
    refusing = false
    assembler.flush()
    expect(messageText((await rig.row(providerItemId('item', 'm1')))?.body)).toBe('Observed text')
  })

  it('keeps window text while the sink is full and retries it, and lets it go once the sink is gone', async () => {
    const runs: (() => void)[] = []
    const rig = await openProviderTimelineRig()
    let refusal: 'backpressure' | 'failed' | null = null
    const assembler = rig.assemble({
      sink: {
        ...rig.sink,
        tryAppendTransition: (transition) =>
          refusal ? { accepted: false, reason: refusal } : rig.sink.tryAppendTransition(transition)
      },
      schedule: (run) => {
        runs.push(run)
        return () => {}
      }
    })
    assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    refusal = 'backpressure'
    assembler.apply({ type: 'text.delta', item: { id: 'm1' }, channel: 'assistant', text: 'Kept' })
    runs.splice(0).forEach((run) => run())
    // Refused under backpressure: still owed, and the window is scheduled again.
    expect(runs).toHaveLength(1)
    refusal = null
    runs.splice(0).forEach((run) => run())
    expect(messageText((await rig.row(providerItemId('item', 'm1')))?.body)).toBe('Kept')

    assembler.apply({ type: 'text.delta', item: { id: 'm2' }, channel: 'assistant', text: 'Lost' })
    refusal = 'failed'
    runs.splice(0).forEach((run) => run())
    // A failed sink can never take it: no retry is scheduled.
    expect(runs).toHaveLength(0)
  })

  it('does not latch a refused session end, so its retry still settles the session', async () => {
    const rig = await openProviderTimelineRig()
    let refusing = false
    const assembler = rig.assemble({ sink: refusingSink(rig.sink, () => refusing) })
    assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    assembler.apply({ type: 'request.open', request: 'p1', body: pendingApproval })
    refusing = true
    const ended = {
      type: 'session.ended',
      verdict: { state: 'interrupted', completedAt: 3_000 }
    } as const
    expect(assembler.apply(ended).admission).toEqual(BACKPRESSURE)
    expect(assembler.apply({ type: 'activity', text: 'still live' }).dropped).toBeUndefined()

    refusing = false
    assembler.apply(ended)
    expect(await rig.turn('t1')).toMatchObject({ state: 'interrupted', completedAt: 3_000 })
    expect((await rig.row(providerItemId('request', 'p1')))?.body).toMatchObject({
      resolution: { state: 'cancelled' }
    })
    expect(assembler.apply({ type: 'turn.open', turn: 't2', at: 4_000 }).dropped).toBe(
      'session-ended'
    )
  })

  it('leaves the open turn in place when a superseding open is refused', async () => {
    const rig = await openProviderTimelineRig()
    let refusing = false
    const assembler = rig.assemble({ sink: refusingSink(rig.sink, () => refusing) })
    assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    const first = assembler.openTurnId
    refusing = true
    expect(assembler.apply({ type: 'turn.open', turn: 't2', at: 2_000 }).admission).toEqual(
      BACKPRESSURE
    )
    expect(assembler.openTurnId).toBe(first)
    refusing = false
    assembler.apply({ type: 'turn.open', turn: 't2', at: 2_000 })
    expect(await rig.turn('t1')).toMatchObject({ state: 'interrupted', outcome: 'superseded' })
    expect(await rig.turn('t2')).toMatchObject({ state: 'running' })
  })
})

describe('what the assembler holds open is bounded', () => {
  it('refuses, as failed, work past its open budget instead of forgetting it', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    for (let index = 0; index < MAX_PROVIDER_TIMELINE_OPEN_ENTRIES / 2; index += 1) {
      expect(
        rig.assembler.apply({ type: 'item.open', item: `item-${index}`, body: runningTool('read') })
          .admission
      ).toEqual({ accepted: true })
      expect(
        rig.assembler.apply({
          type: 'request.open',
          request: `request-${index}`,
          body: pendingApproval
        }).admission
      ).toEqual({ accepted: true })
    }
    const refused = { accepted: false, reason: 'failed' }
    expect(
      rig.assembler.apply({ type: 'item.open', item: 'one-more', body: runningTool('read') })
        .admission
    ).toEqual(refused)
    expect(
      rig.assembler.apply({ type: 'request.open', request: 'one-more', body: pendingApproval })
        .admission
    ).toEqual(refused)
    expect(
      rig.assembler.apply({
        type: 'text.delta',
        item: { stream: 'more' },
        channel: 'assistant',
        text: 'x'
      }).admission
    ).toEqual(refused)
    expect(await rig.row(providerItemId('item', 'one-more'))).toBeUndefined()

    // Settling frees the budget again.
    rig.assembler.apply({ type: 'turn.end', at: 2_000, state: 'completed' })
    rig.assembler.apply({ type: 'turn.open', turn: 't2', at: 3_000 })
    expect(
      rig.assembler.apply({ type: 'item.open', item: 'one-more', body: runningTool('read') })
        .admission
    ).toEqual({ accepted: true })
  })

  it('refuses a stream past the budget, even though the coalescer would hold it', async () => {
    const rig = await openProviderTimelineRig({ schedule: () => () => {} })
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    let admitted = 0
    for (let index = 0; index < 1_100; index += 1) {
      const { admission } = rig.assembler.apply({
        type: 'text.delta',
        item: { id: `m${index}` },
        channel: 'assistant',
        text: 'x'
      })
      admitted += admission.accepted ? 1 : 0
    }
    expect(admitted).toBe(MAX_PROVIDER_TIMELINE_OPEN_ENTRIES)
  })
})
