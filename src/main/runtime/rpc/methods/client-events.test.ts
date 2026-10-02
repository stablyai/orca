import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RoomService } from '../../rooms/service'
import { roomHarnessRuntimeFixture } from '../../rooms/room-harness-runtime.test-fixture'
import { eraseRpcMethods, isStreamingMethod, type RpcStreamingMethod } from '../core'
// Why: importing client-events directly trips its module-init cycle through ipc/ssh; the index resolves it.
import { ALL_RPC_METHODS } from './index'

const subscribeMethod = eraseRpcMethods(ALL_RPC_METHODS).find(
  (method) => method.name === 'runtime.clientEvents.subscribe' && isStreamingMethod(method)
) as RpcStreamingMethod

function makeRuntime(): {
  runtime: OrcaRuntimeService
  onClientEvent: ReturnType<typeof vi.fn>
  cleanups: (() => void)[]
} {
  const cleanups: (() => void)[] = []
  const onClientEvent = vi.fn(
    (
      _listener: (event: RuntimeClientEvent) => void,
      _options?: { consumesTerminalSideEffects?: boolean }
    ) =>
      () => {}
  )
  const runtime = new OrcaRuntimeService()
  const rooms = new RoomService(':memory:', roomHarnessRuntimeFixture(), {})
  afterEach(() => rooms.close())
  vi.spyOn(rooms.db.notificationReplay, 'list').mockReturnValue({
    messages: [],
    cursor: 42,
    hasMore: false
  })
  vi.spyOn(runtime, 'getRoomService').mockReturnValue(rooms)
  vi.spyOn(runtime, 'onClientEvent').mockImplementation(onClientEvent)
  vi.spyOn(runtime, 'registerSubscriptionCleanup').mockImplementation((_id, cleanup) => {
    cleanups.push(cleanup)
  })
  return { runtime, onClientEvent, cleanups }
}

describe('runtime.clientEvents.subscribe', () => {
  it('registers mobile subscriptions as non-consumers of terminal side effects', async () => {
    const { runtime, onClientEvent, cleanups } = makeRuntime()

    const done = subscribeMethod.handler(
      undefined,
      { runtime, connectionId: 'conn-1', clientKind: 'mobile' },
      () => {}
    )

    expect(onClientEvent).toHaveBeenCalledWith(expect.any(Function), {
      consumesTerminalSideEffects: false
    })
    cleanups.forEach((cleanup) => cleanup())
    await done
  })

  it('keeps non-mobile subscriptions consuming terminal side effects', async () => {
    const { runtime, onClientEvent, cleanups } = makeRuntime()

    const done = subscribeMethod.handler(undefined, { runtime, connectionId: 'conn-1' }, () => {})

    expect(onClientEvent).toHaveBeenCalledWith(expect.any(Function), {
      consumesTerminalSideEffects: true
    })
    cleanups.forEach((cleanup) => cleanup())
    await done
  })

  it('includes the room notification baseline in the ready snapshot', async () => {
    const { runtime, cleanups } = makeRuntime()
    const emit = vi.fn()

    const done = subscribeMethod.handler(undefined, { runtime, connectionId: 'conn-1' }, emit)

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ready',
        snapshot: expect.objectContaining({ roomNotificationSequence: 42 })
      })
    )
    cleanups.forEach((cleanup) => cleanup())
    await done
  })
})
