import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod } from '../core'
// Why: importing client-events directly trips its module-init cycle through ipc/ssh; the index resolves it.
import { ALL_RPC_METHODS } from './index'

const subscribeMethod = eraseRpcMethods(ALL_RPC_METHODS).find(
  (method) => method.name === 'runtime.clientEvents.subscribe' && isStreamingMethod(method)
)
if (!subscribeMethod || !isStreamingMethod(subscribeMethod)) {
  throw new Error('Missing runtime.clientEvents.subscribe stream')
}

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
  const stub: Pick<
    OrcaRuntimeService,
    'onClientEvent' | 'getTerminalInterfaceClientEventSnapshot' | 'registerSubscriptionCleanup'
  > = {
    onClientEvent,
    getTerminalInterfaceClientEventSnapshot: () => [],
    registerSubscriptionCleanup: (_id: string, cleanup: () => void) => {
      cleanups.push(cleanup)
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the subscription handler reaches only these checked runtime methods; optional snapshot readers are absent.
  const runtime = stub as OrcaRuntimeService
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
})

// The same stream serves desktop IPC and paired sockets; only negotiated readers see this facet.
it('replays rowless state listener-first, filters old peers, and sends the empty replacement', async () => {
  const event: RuntimeClientEvent = {
    type: 'terminalInterfaces',
    epoch: 'host',
    revision: 2,
    observations: []
  }
  for (const capable of [false, true]) {
    const { runtime, onClientEvent, cleanups } = makeRuntime()
    runtime.getTerminalInterfaceClientEventSnapshot = () => [event]
    const frames: unknown[] = []
    const done = subscribeMethod.handler(
      undefined,
      {
        runtime,
        clientKind: 'runtime',
        caller: { kind: 'desktop' },
        clientCapabilities: capable ? ['terminal.interface.v1'] : []
      },
      (frame) => frames.push(frame)
    )
    expect(onClientEvent).toHaveBeenCalledWith(expect.any(Function), {
      consumesTerminalSideEffects: false
    })
    expect(frames.some((frame) => frame === event)).toBe(capable)
    onClientEvent.mock.calls[0]?.[0]({ ...event, revision: 3 })
    expect(
      frames.filter(
        (frame) =>
          typeof frame === 'object' &&
          frame !== null &&
          'type' in frame &&
          frame.type === 'terminalInterfaces'
      )
    ).toHaveLength(capable ? 2 : 0)
    cleanups.forEach((cleanup) => cleanup())
    await done
  }
})
