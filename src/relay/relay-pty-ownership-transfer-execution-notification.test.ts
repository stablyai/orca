import { afterEach, expect, it, vi } from 'vitest'
import {
  identity,
  preparation,
  request,
  context,
  makeDelegatedRelay
} from './relay-pty-ownership-transfer-delegation-test-fixture'
import type { MethodHandler, RelayDispatcher } from './dispatcher'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_SUBSCRIBE_METHOD } from '../shared/pty-ownership-transfer-destination-claim'
import { RELAY_PTY_DESTINATION_EXECUTION_NOTIFICATION } from '../shared/pty-ownership-transfer-execution-notification'

afterEach(() => vi.useRealTimers())
async function setup(optIn: boolean) {
  vi.useFakeTimers()
  const save = vi.fn()
  const adapter = makeDelegatedRelay(
    { loadAll: () => [], save, remove: () => {} },
    {
      enableDestinationOutputRoutes: true,
      enableDestinationOutputRetention: true,
      resolveTerminalIncarnation: () => identity.incarnationId
    }
  )
  adapter.prepare(preparation)
  adapter.claimDestination(request(), context())
  const handlers = new Map<string, MethodHandler>()
  let capacity = () => {}
  const publish = vi.fn(() => true)
  adapter.register({
    onRequest: (name: string, handler: MethodHandler) => handlers.set(name, handler),
    onLegacyPtyCapacity: (callback: () => void) => {
      capacity = callback
      return () => {}
    },
    onClientDetached: () => () => {},
    onDisposed: () => () => {},
    publishProducerNotification: publish
  } as unknown as RelayDispatcher)
  const response = await handlers.get(PTY_OWNERSHIP_TRANSFER_DESTINATION_SUBSCRIBE_METHOD)!(
    {
      ...request(),
      afterSeq: 0,
      destinationClaim: { generation: 1, claimId: 'claim-1' },
      ...(optIn ? { executionNotifications: 1 } : {})
    },
    context()
  )
  return { adapter, response, save, publish, capacity: () => capacity() }
}

it.each([false, true])('publishes only to opted-in destinations (%s)', async (optIn) => {
  const f = await setup(optIn)
  f.adapter.observeExit(identity.terminalId, identity.incarnationId, 17)
  await vi.runAllTimersAsync()
  expect(f.publish).toHaveBeenCalledTimes(optIn ? 1 : 0)
  if (optIn) {
    expect(f.response).toMatchObject({ executionNotifications: 1 })
    expect(f.publish).toHaveBeenCalledWith(
      2,
      RELAY_PTY_DESTINATION_EXECUTION_NOTIFICATION,
      expect.objectContaining({
        ...identity,
        finalOutputSeq: 0,
        destinationClaim: { generation: 1, claimId: 'claim-1' }
      }),
      { logDrop: false }
    )
  } else {
    expect(f.response).not.toHaveProperty('executionNotifications')
  }
})

it('withholds a hint after uncertain exit persistence until recovery succeeds', async () => {
  const f = await setup(true)
  f.save.mockImplementationOnce(() => {
    throw new Error('disk failure')
  })
  expect(() => f.adapter.observeExit(identity.terminalId, identity.incarnationId, 17)).toThrow(
    'disk failure'
  )
  await vi.runAllTimersAsync()
  expect(f.publish).not.toHaveBeenCalled()
  f.adapter.observeExit(identity.terminalId, identity.incarnationId, 17)
  await vi.runAllTimersAsync()
  expect(f.publish).toHaveBeenCalledOnce()
})

it('retries backpressured hints on capacity and does not repeat accepted hints', async () => {
  const f = await setup(true)
  f.publish.mockReturnValueOnce(false)
  f.adapter.observeExit(identity.terminalId, identity.incarnationId, 17)
  await vi.runAllTimersAsync()
  expect(f.publish).toHaveBeenCalledOnce()
  f.capacity()
  await vi.runAllTimersAsync()
  expect(f.publish).toHaveBeenCalledTimes(2)
  f.capacity()
  await vi.runAllTimersAsync()
  expect(f.publish).toHaveBeenCalledTimes(2)
})
