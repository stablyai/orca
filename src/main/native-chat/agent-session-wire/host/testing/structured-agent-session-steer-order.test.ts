import { afterEach, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'

let rig: QueuedMessageTestRig | undefined
afterEach(async () => {
  await rig?.dispose()
})

it('delivers accepted steers in order when a later request promotes an older draft', async () => {
  const r = (rig = await createQueuedMessageTestRig())
  const opener = await r.workingSend()
  await r.settleAccepted(opener, 'opening')
  await openRigTurnFor(r, opener)
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  r.dispatch.mockImplementationOnce(async () => {
    entered()
    await held
    return { state: 'admitted' }
  })
  try {
    await r.send('in flight').result
    await started
    const older = r.send('B', 'queue-if-active')
    await older.result
    const a = r.send('A')
    expect(await a.result).toMatchObject({ ok: true, value: { queued: { state: 'waiting' } } })
    expect(await r.sendNow(older.id)).toMatchObject({
      ok: true,
      value: { queued: { state: 'waiting' } }
    })
    expect(await r.sendNow(a.id)).toMatchObject({
      ok: true,
      value: { queued: { messageId: a.id, state: 'waiting' } }
    })
    release()
    await eventually(() =>
      expect(r.dispatch.mock.calls.map(([input]) => input.body.blocks)).toEqual([
        [{ type: 'text', text: 'work on this' }],
        [{ type: 'text', text: 'in flight' }],
        [{ type: 'text', text: 'A' }],
        [{ type: 'text', text: 'B' }]
      ])
    )
  } finally {
    release()
  }
})
