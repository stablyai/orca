import { expect, it, vi } from 'vitest'
import { moveStructuredAgentSessionChatsToSelectedAccount } from '../../recovery/structured-agent-session-account-switch'
import {
  PARENT,
  createReceivingCallerFixture
} from './structured-agent-session-receiving-callers.test-support'
import {
  type AccountSwitchFixture,
  accountHome,
  chatOwingBackgroundTask,
  dispatchedTexts,
  MOVED_MESSAGE,
  rows,
  sendWith
} from './structured-agent-session-account-switch.test-support'

const waiters = (f: AccountSwitchFixture): number =>
  f.rig.host['clientDelivery']['sendSettlement']['waiters'].get(PARENT)?.size ?? 0

async function chatHoldingASend(f: AccountSwitchFixture): Promise<string> {
  await f.found()
  f.rig.adapter.dispatch.mockImplementationOnce(async () => ({ state: 'admitted' }))
  const id = await f.accept('write the report')
  await vi.waitFor(() => expect(f.rig.adapter.dispatch).toHaveBeenCalledTimes(1))
  return id
}

const settle = (f: AccountSwitchFixture, id: string) =>
  f.rig.host.settleLateDispatch({
    sessionId: PARENT,
    clientMessageId: id,
    providerIdentity: { provider: 'claude', sessionId: `provider-${PARENT}`, uuid: `echo-${id}` }
  })

it('a move waiting on a held send stops nothing once the setting leaves restart-all', async () => {
  const f = await createReceivingCallerFixture()
  try {
    const id = await chatHoldingASend(f)
    let policy = 'restart-all'
    f.selectB()
    const moved = moveStructuredAgentSessionChatsToSelectedAccount(
      f.rig.host,
      () => policy === 'restart-all'
    )
    await vi.waitFor(() => expect(waiters(f)).toBe(1))
    policy = 'keep'
    await settle(f, id)
    await moved
    expect(f.launches).toEqual([accountHome(f, 'a')])
    expect(dispatchedTexts(f)).toEqual(['write the report'])
  } finally {
    await f.dispose()
  }
})

it('repeated switches during one held send hold one settlement waiter for the chat', async () => {
  const f = await createReceivingCallerFixture()
  try {
    const id = await chatHoldingASend(f)
    let peak = 0
    const wait = f.rig.host.waitForSendSettlement
    vi.spyOn(f.rig.host, 'waitForSendSettlement').mockImplementation((...args) => {
      const waiting = wait(...args)
      peak = Math.max(peak, waiters(f))
      return waiting
    })
    const moves = (['b', 'a', 'b', 'a', 'b'] as const).map((account) => {
      f.select(account)
      return moveStructuredAgentSessionChatsToSelectedAccount(f.rig.host, () => true)
    })
    await vi.waitFor(() => expect(waiters(f)).toBe(1))
    await settle(f, id)
    await Promise.all(moves)
    expect(peak).toBe(1)
    expect(f.launches).toEqual([accountHome(f, 'a'), accountHome(f, 'b')])
  } finally {
    await f.dispose()
  }
})

it('a move lets a queued send already taken from the queue reach the agent before stopping it', async () => {
  const f = await createReceivingCallerFixture()
  const firstHandedOver = Promise.withResolvers<void>()
  try {
    await chatOwingBackgroundTask(f)
    const id = await f.send('refactor the parser')
    await f.turn(id, 'running')
    await sendWith(f, 'then add tests', { userSend: true, delivery: 'queue-if-active' })
    await sendWith(f, 'then update the docs', { userSend: true, delivery: 'queue-if-active' })
    const accept = f.rig.adapter.dispatch.getMockImplementation()!
    f.rig.adapter.dispatch.mockImplementationOnce(async (input) => {
      await firstHandedOver.promise
      return accept(input)
    })
    await f.turn(id, 'completed')
    await vi.waitFor(() => expect(f.rig.adapter.dispatch).toHaveBeenCalledTimes(3))
    f.selectB()
    const moved = moveStructuredAgentSessionChatsToSelectedAccount(f.rig.host, () => true)
    firstHandedOver.resolve()
    await moved
    expect(f.rig.adapter.dispatch.mock.calls.map(([input]) => input.fence)).toEqual([1, 1, 1, 1, 3])
    expect(f.launches).toEqual([accountHome(f, 'a'), accountHome(f, 'b')])
    expect(dispatchedTexts(f)).toEqual([
      'start the dev server',
      'refactor the parser',
      'then add tests',
      'then update the docs',
      MOVED_MESSAGE
    ])
    expect(await rows(f)).not.toContainEqual(
      expect.objectContaining({ text: 'Claude stopped before this message was sent.' })
    )
  } finally {
    firstHandedOver.resolve()
    await f.dispose()
  }
})
