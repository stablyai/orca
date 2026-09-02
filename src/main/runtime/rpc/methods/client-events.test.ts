import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { isStreamingMethod, type RpcContext, type RpcStreamingMethod } from '../core'
// Why: importing client-events directly trips its module-init cycle through ipc/ssh; the index resolves it.
import { ALL_RPC_METHODS } from './index'

const subscribeMethod = ALL_RPC_METHODS.find(
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
  const runtime = {
    onClientEvent,
    registerSubscriptionCleanup: (_id: string, cleanup: () => void) => {
      cleanups.push(cleanup)
    }
  } as unknown as OrcaRuntimeService
  return { runtime, onClientEvent, cleanups }
}

describe('runtime.clientEvents.subscribe', () => {
  it('registers mobile subscriptions as non-consumers of terminal side effects', async () => {
    const { runtime, onClientEvent, cleanups } = makeRuntime()

    const done = subscribeMethod.handler(
      undefined,
      { runtime, connectionId: 'conn-1', clientKind: 'mobile' } as RpcContext,
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

    const done = subscribeMethod.handler(
      undefined,
      { runtime, connectionId: 'conn-1' } as RpcContext,
      () => {}
    )

    expect(onClientEvent).toHaveBeenCalledWith(expect.any(Function), {
      consumesTerminalSideEffects: true
    })
    cleanups.forEach((cleanup) => cleanup())
    await done
  })
})
