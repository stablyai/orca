import { afterEach, describe, expect, it } from 'vitest'
import {
  closeProviderTimelineRigs,
  messageText,
  openProviderTimelineRig,
  providerItemId,
  providerTurnId,
  providerTurnItemId,
  runningTool
} from './provider-timeline-assembler-test-support'

afterEach(closeProviderTimelineRigs)

describe("an earlier turn's late end leaves the open turn alone", () => {
  it("keeps the open turn's activity line", async () => {
    const rig = await openProviderTimelineRig()
    const activity: unknown[] = []
    const assembler = rig.assemble({
      sink: { ...rig.sink, setActivity: (each) => activity.push(each) }
    })
    assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    assembler.apply({ type: 'turn.end', turn: 't1', at: 1_500, state: 'completed' })
    assembler.apply({ type: 'turn.open', turn: 't2', at: 2_000 })
    assembler.apply({ type: 'activity', text: 'Thinking' })
    activity.length = 0
    expect(
      assembler.apply({ type: 'turn.end', turn: 't1', at: 2_100, state: 'completed' })
    ).toEqual({ admission: { accepted: true } })
    expect(activity).toEqual([])
    expect(assembler.openTurnId).toBe(providerTurnId('t2'))
  })

  it("keeps the open turn's anonymous reply one message", async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({ type: 'turn.end', turn: 't1', at: 1_500, state: 'completed' })
    rig.assembler.apply({ type: 'turn.open', turn: 't2', at: 2_000 })
    const delta = { type: 'text.delta', item: { stream: 'reply' }, channel: 'assistant' } as const
    rig.assembler.apply({ ...delta, text: 'Hello' })
    rig.assembler.apply({ type: 'turn.end', turn: 't1', at: 2_100, state: 'completed' })
    rig.assembler.apply({ ...delta, text: ' world' })
    const texts = (await rig.rows()).flatMap((row) =>
      row.body.kind === 'message' ? [[row.turnScope, messageText(row.body)]] : []
    )
    expect(texts).toEqual([[{ kind: 'turn', turnItemId: providerTurnItemId('t2') }, 'Hello world']])
  })

  it("leaves the open turn's running work to that turn's own end", async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({ type: 'turn.open', turn: 't2', at: 2_000 })
    rig.assembler.apply({ type: 'item.open', item: 'call', body: runningTool('read') })
    rig.assembler.apply({ type: 'turn.end', turn: 't1', at: 2_100, state: 'completed' })
    expect((await rig.row(providerItemId('item', 'call')))?.body).toMatchObject({
      state: 'running'
    })
    rig.assembler.apply({ type: 'turn.end', turn: 't2', at: 2_200, state: 'interrupted' })
    expect((await rig.row(providerItemId('item', 'call')))?.body).toMatchObject({
      state: 'failed'
    })
  })
})
