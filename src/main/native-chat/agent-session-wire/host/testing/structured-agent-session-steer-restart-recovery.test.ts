import { afterEach, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data.test-fixture'

let rig: QueuedMessageTestRig | undefined
afterEach(async () => {
  await rig?.dispose()
})

it('publishes an unsent steer as restart-held until the person explicitly sends it', async () => {
  const r = (rig = await createQueuedMessageTestRig({ restartable: true }))
  await r.workingSend()
  const b = r.send('B: check the remote session')
  expect(await b.result).toMatchObject({ ok: true, value: { queued: { messageId: b.id } } })
  const pending = await r.host.history({ sessionId: SESSION, direction: 'tail' })
  expect(pending).toMatchObject({
    ok: true,
    page: { queuedMessages: [{ messageId: b.id, state: 'waiting', deliveryMode: 'steer' }] }
  })
  if (!pending.ok) {
    throw new Error('history refused')
  }
  expect(pending.page.queuedMessages?.[0]).not.toHaveProperty('paused')

  await r.host.close(SESSION, 'evict')
  await r.restartHostProcess()
  const reopened = await r.host.history({ sessionId: SESSION, direction: 'tail' })
  expect(reopened).toMatchObject({
    ok: true,
    page: {
      nextQueuedMessageId: null,
      queuedMessages: [
        {
          messageId: b.id,
          state: 'waiting',
          deliveryMode: 'steer',
          paused: true,
          pausedReason: 'restarted'
        }
      ]
    }
  })
  expect(await r.handoff(b.id)).toBeUndefined()
  expect(await r.sendNow(b.id)).toMatchObject({ ok: true })
  await eventually(async () =>
    expect(await r.handoff(b.id)).toMatchObject({
      queuedMessageId: b.id,
      dispatchState: 'pending',
      handedOverAt: expect.any(Number)
    })
  )
  expect(r.dispatch.mock.calls.map(([input]) => input.body.blocks)).toEqual([
    [{ type: 'text', text: 'work on this' }],
    [{ type: 'text', text: 'B: check the remote session' }]
  ])
})
