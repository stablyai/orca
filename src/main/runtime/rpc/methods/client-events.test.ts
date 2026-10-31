import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  eraseRpcMethods,
  isStreamingMethod,
  type RpcContext,
  type RpcStreamingMethod
} from '../core'
// Import the registry to avoid client-events' module-init cycle through ipc/ssh.
import { ALL_RPC_METHODS } from './index'
import { RuntimeClientEventBus } from '../../runtime-client-event-bus'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The registry declares this exact name as streaming and the predicate checks isStreamingMethod; find still types absence, while all three cases invoke the real registered handler.
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
      options?: { consumesTerminalSideEffects?: boolean; initialize?: () => void }
    ) => {
      options?.initialize?.()
      return () => {}
    }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The real subscribe handler uses these settings/listener/cleanup members plus optional snapshots; a full runtime needs unrelated services, and the real bus case proves ready-before-live initialization.
  const runtime = {
    getClientSettings: () => ({ nativeChatQueueFollowUps: false }),
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
      { runtime, connectionId: 'conn-1', clientKind: 'mobile' } satisfies RpcContext,
      () => {}
    )

    expect(onClientEvent).toHaveBeenCalledWith(expect.any(Function), {
      consumesTerminalSideEffects: false,
      initialize: expect.any(Function)
    })
    cleanups.forEach((cleanup) => cleanup())
    await done
  })

  it('keeps non-mobile subscriptions consuming terminal side effects', async () => {
    const { runtime, onClientEvent, cleanups } = makeRuntime()

    const done = subscribeMethod.handler(
      undefined,
      { runtime, connectionId: 'conn-1' } satisfies RpcContext,
      () => {}
    )

    expect(onClientEvent).toHaveBeenCalledWith(expect.any(Function), {
      consumesTerminalSideEffects: true,
      initialize: expect.any(Function)
    })
    cleanups.forEach((cleanup) => cleanup())
    await done
  })

  it('publishes the historical baseline before availability can synchronously publish live facts', async () => {
    const historical: { type: unknown }[] = []
    const live: RuntimeClientEvent = {
      type: 'terminalSideEffects',
      batch: {
        ptyId: 'physical',
        seq: 1,
        facts: [{ kind: 'bell' }]
      }
    }
    const bus = new RuntimeClientEventBus({
      makeTitleGateKey: (raw) => raw,
      onConsumerAvailabilityChanged: () => {
        if (bus.countTerminalSideEffectConsumers()) {
          bus.emit(live)
        }
      }
    })
    const { runtime, cleanups } = makeRuntime()
    runtime.onClientEvent = bus.on.bind(bus)
    runtime.getTerminalSideEffectClientEventSnapshot = () => []
    const done = subscribeMethod.handler(
      undefined,
      {
        runtime,
        connectionId: 'ordering',
        clientCapabilities: ['terminal-side-effect-state.v1']
      } satisfies RpcContext,
      (event) => {
        if (typeof event !== 'object' || event === null || !('type' in event)) {
          throw new Error('Runtime event must have a type')
        }
        historical.push(event)
      }
    )
    expect(historical.map((event) => event.type)).toEqual(['ready', 'terminalSideEffects'])
    cleanups.forEach((cleanup) => cleanup())
    await done
  })
})
