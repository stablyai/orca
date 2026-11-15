import { afterEach, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../shared/agent-session/failures/agent-session-failure-words'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data.test-fixture'

let rig: QueuedMessageTestRig | undefined
afterEach(async () => {
  await rig?.dispose()
})

it('delivers a second steer before the running turn ends or the first steer echoes', async () => {
  const r = (rig = await createQueuedMessageTestRig())
  const opener = await r.workingSend()
  await r.settleAccepted(opener, 'opening')
  await openRigTurnFor(r, opener)
  const a = r.send('A')
  expect(await a.result).toMatchObject({ ok: true, value: { queued: { messageId: a.id } } })
  await eventually(async () => expect((await r.handoff(a.id))?.handedOverAt).toBeDefined())
  const b = r.send('B')
  expect(await b.result).toMatchObject({ ok: true, value: { queued: { messageId: b.id } } })
  await eventually(async () => expect((await r.handoff(b.id))?.handedOverAt).toBeDefined())
  expect((await r.handoff(a.id))?.dispatchState).toBe('pending')
  expect((await r.handoff(b.id))?.dispatchState).toBe('pending')
  expect(r.dispatch.mock.calls.map(([input]) => input.body.blocks)).toEqual([
    [{ type: 'text', text: 'work on this' }],
    [{ type: 'text', text: 'A' }],
    [{ type: 'text', text: 'B' }]
  ])
})

it('accepts Send now while A is in flight, keeps B cancellable and replays without redelivery', async () => {
  const r = (rig = await createQueuedMessageTestRig())
  const opener = await r.workingSend()
  await r.settleAccepted(opener, 'opening')
  await openRigTurnFor(r, opener)
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  r.dispatch.mockImplementationOnce(async () => {
    await held
    return { state: 'admitted' }
  })
  try {
    const a = r.send('A')
    await a.result
    await eventually(async () => expect((await r.handoff(a.id))?.handedOverAt).toBeDefined())
    const b = r.send('B', 'queue-if-active')
    await b.result
    const operation = hostTestOperationId()
    expect(await r.sendNow(b.id, operation)).toMatchObject({
      ok: true,
      value: { queued: { messageId: b.id, state: 'waiting' } }
    })
    expect(await r.sendNow(b.id, operation)).toMatchObject({ ok: true })
    const page = await r.host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page).toMatchObject({
      ok: true,
      page: { queuedMessages: [{ messageId: b.id, deliveryMode: 'steer' }] }
    })
    expect(await r.deleteQueued(b.id)).toMatchObject({ ok: true, value: { deleted: true } })
    release()
    const c = r.send('C')
    await c.result
    await eventually(async () => expect((await r.handoff(c.id))?.handedOverAt).toBeDefined())
    expect(await r.sendNow(b.id, operation)).toMatchObject({
      ok: true,
      value: { queued: { state: 'withdrawn' } }
    })
    expect(r.dispatch.mock.calls.map(([input]) => input.body.blocks)).toEqual([
      [{ type: 'text', text: 'work on this' }],
      [{ type: 'text', text: 'A' }],
      [{ type: 'text', text: 'C' }]
    ])
  } finally {
    release()
  }
})

it.each(['unknown', 'rejected'] as const)(
  'retains A as %s and delivers the accepted B steer without draining ordinary follow-ups',
  async (state) => {
    const r = (rig = await createQueuedMessageTestRig())
    const opener = await r.workingSend()
    await r.settleAccepted(opener, 'opening')
    await openRigTurnFor(r, opener)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    r.dispatch.mockImplementationOnce(async () => {
      await held
      return state === 'unknown'
        ? { state, reason: 'transport failed' }
        : {
            state,
            ...agentSessionFailureWords(agentSessionFailureFact('writeFailed'), {
              surface: 'rejection'
            })
          }
    })
    try {
      const a = r.send('A')
      await a.result
      await eventually(async () => expect((await r.handoff(a.id))?.handedOverAt).toBeDefined())
      const ordinary = r.send('after the turn', 'queue-if-active')
      await ordinary.result
      const b = r.send('B', 'queue-if-active')
      await b.result
      const operation = hostTestOperationId()
      expect(await r.sendNow(b.id, operation)).toMatchObject({
        ok: true,
        value: { queued: { state: 'waiting' } }
      })
      expect(await r.handoff(b.id)).toBeUndefined()
      release()
      await eventually(async () => expect((await r.handoff(b.id))?.handedOverAt).toBeDefined())
      expect((await r.handoff(a.id))?.dispatchState).toBe(state)
      const bId = await r.handoffId(b.id)
      await r.settleAccepted(bId, 'B-received')
      expect(await r.sendNow(b.id, operation)).toMatchObject({
        ok: true,
        value: { submission: { dispatchState: 'accepted' } }
      })
      expect(await r.handoff(ordinary.id)).toBeUndefined()
      expect(
        r.dispatch.mock.calls.map(([input]) => ({
          sessionId: input.sessionId,
          blocks: input.body.blocks
        }))
      ).toEqual([
        { sessionId: 'session-alpha', blocks: [{ type: 'text', text: 'work on this' }] },
        { sessionId: 'session-alpha', blocks: [{ type: 'text', text: 'A' }] },
        { sessionId: 'session-alpha', blocks: [{ type: 'text', text: 'B' }] }
      ])
    } finally {
      release()
    }
  }
)
