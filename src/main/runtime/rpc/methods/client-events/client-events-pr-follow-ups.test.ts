import { expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../../../../shared/runtime-client-events'
import { eraseRpcMethods, isStreamingMethod } from '../../core'
import { ALL_RPC_METHODS } from '../rpc-method-registry'

it('admits no hidden follow-up stream and filters available follow-ups before serializing terminal events', async () => {
  const method = eraseRpcMethods(ALL_RPC_METHODS)
    .filter(isStreamingMethod)
    .find((entry) => entry.name === 'runtime.clientEvents.subscribe')!
  let listener: (event: RuntimeClientEvent) => void = () => undefined
  let stop: () => void = () => undefined
  const unsubscribe = vi.fn()
  const runtime = {
    prFollowUps: undefined as object | undefined,
    onClientEvent: vi.fn((onEvent, _options) => {
      listener = onEvent
      return unsubscribe
    }),
    registerSubscriptionCleanup: (_id: string, cleanup: () => void) => {
      stop = cleanup
    },
    getTerminalSleepClientEventSnapshot: vi.fn(),
    getNativeChatLaunchDraftResolutionClientEventSnapshot: vi.fn()
  }
  const emit = vi.fn()
  await method.handler({ prFollowUpsOnly: true }, { runtime } as never, emit)
  expect(runtime.onClientEvent).not.toHaveBeenCalled()
  emit.mockClear()
  runtime.prFollowUps = {}
  const done = method.handler({ prFollowUpsOnly: true }, { runtime } as never, emit)
  expect(runtime.onClientEvent).toHaveBeenCalledWith(expect.any(Function), {
    consumesTerminalSideEffects: false
  })
  emit.mockClear()
  listener({ type: 'terminalSideEffects' } as never)
  listener({ type: 'reposChanged' })
  expect(emit).not.toHaveBeenCalled()
  listener({ type: 'prFollowUpsChanged' })
  expect(emit).toHaveBeenCalledExactlyOnceWith({ type: 'prFollowUpsChanged' })
  expect(runtime.getTerminalSleepClientEventSnapshot).not.toHaveBeenCalled()
  stop()
  await done
  expect(unsubscribe).toHaveBeenCalledOnce()
})
