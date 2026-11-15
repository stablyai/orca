import { afterEach, expect, it, vi } from 'vitest'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data.test-fixture'

let rig: QueuedMessageTestRig | undefined
afterEach(async () => {
  vi.useRealTimers()
  await rig?.dispose()
})

it('expires a stuck steer without late writes or holding the following steer', async () => {
  const r = (rig = await createQueuedMessageTestRig())
  const opener = await r.workingSend()
  await r.settleAccepted(opener, 'opening')
  await openRigTurnFor(r, opener)
  const held = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  const written: string[] = []
  r.dispatch.mockImplementationOnce(async (input) => {
    entered.resolve()
    try {
      await held.promise
      await input.admitFreshInput!(
        () => {
          written.push('A')
          return { kind: 'sent', response: Promise.resolve() }
        },
        input.signal,
        'steer'
      )
      return { state: 'admitted' }
    } finally {
      finished.resolve()
    }
  })
  r.dispatch.mockImplementation(async () => {
    written.push('B')
    return { state: 'admitted' }
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const a = r.send('A')
    await a.result
    await entered.promise
    const b = r.send('B')
    expect(await b.result).toMatchObject({ ok: true, value: { queued: { state: 'waiting' } } })
    await vi.advanceTimersByTimeAsync(60_000)
    vi.useRealTimers()
    await eventually(async () => {
      expect(await r.handoff(a.id)).toMatchObject({ dispatchState: 'unknown' })
      expect(written).toEqual(['B'])
    })
    held.resolve()
    await finished.promise
    expect(written).toEqual(['B'])
    expect(await r.handoff(b.id)).toMatchObject({ dispatchState: 'pending' })
    await eventually(async () =>
      expect(await r.handoff(a.id)).toMatchObject({
        dispatchState: 'rejected',
        rejection: { kind: 'writeFailed', neverReachedAgent: true }
      })
    )
    expect(await r.host.history({ sessionId: SESSION, direction: 'tail' })).toMatchObject({
      ok: true,
      page: { queuedMessages: [{ messageId: a.id, state: 'returned' }] }
    })
    expect(await r.sendNow(a.id)).toMatchObject({ ok: true })
    await eventually(async () =>
      expect(await r.handoff(a.id)).toMatchObject({ dispatchState: 'pending' })
    )
    await eventually(() =>
      expect(r.dispatch.mock.calls.map(([input]) => input.body.blocks)).toEqual([
        [{ type: 'text', text: 'work on this' }],
        [{ type: 'text', text: 'A' }],
        [{ type: 'text', text: 'B' }],
        [{ type: 'text', text: 'A' }]
      ])
    )
  } finally {
    held.resolve()
  }
})

it('reconciles a late provider receipt after expiry without resending either steer', async () => {
  const r = (rig = await createQueuedMessageTestRig())
  const opener = await r.workingSend()
  await r.settleAccepted(opener, 'opening')
  await openRigTurnFor(r, opener)
  const held = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  r.dispatch.mockImplementationOnce(async () => {
    entered.resolve()
    await held.promise
    return {
      state: 'accepted',
      providerIdentity: {
        provider: 'codex',
        threadId: 'thread-alpha',
        turnId: 'late-A',
        ordinal: 0
      }
    }
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const a = r.send('A')
    await a.result
    await entered.promise
    const b = r.send('B')
    await b.result
    await vi.advanceTimersByTimeAsync(60_000)
    vi.useRealTimers()
    await eventually(async () => {
      expect(await r.handoff(a.id)).toMatchObject({ dispatchState: 'unknown' })
      expect(await r.handoff(b.id)).toMatchObject({ dispatchState: 'pending' })
    })
    held.resolve()
    await eventually(async () =>
      expect(await r.handoff(a.id)).toMatchObject({ dispatchState: 'accepted' })
    )
    expect(r.dispatch.mock.calls.map(([input]) => input.body.blocks)).toEqual([
      [{ type: 'text', text: 'work on this' }],
      [{ type: 'text', text: 'A' }],
      [{ type: 'text', text: 'B' }]
    ])
  } finally {
    held.resolve()
  }
})
