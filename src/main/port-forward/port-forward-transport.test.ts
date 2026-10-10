import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PairingOffer } from '../../shared/pairing'
import type {
  RemoteRuntimeSubscription,
  RemoteRuntimeSubscriptionCallbacks
} from '../../shared/remote-runtime-client'

const { subscribeRemoteRuntimeRequestMock } = vi.hoisted(() => ({
  subscribeRemoteRuntimeRequestMock: vi.fn()
}))

vi.mock('../../shared/remote-runtime-client', () => ({
  subscribeRemoteRuntimeRequest: subscribeRemoteRuntimeRequestMock
}))

import { PortForwardTransport } from './port-forward-transport'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the transport only forwards this value to the (mocked) subscribe call; no field of it is read here.
const PAIRING = {} as PairingOffer

afterEach(() => {
  subscribeRemoteRuntimeRequestMock.mockReset()
})

/** Resolves a subscription the test controls, without announcing readiness. */
function stubSubscription(closeSubscription = vi.fn()) {
  let callbacks: RemoteRuntimeSubscriptionCallbacks | undefined
  subscribeRemoteRuntimeRequestMock.mockImplementation(
    (
      _pairing: PairingOffer,
      _method: string,
      _params: unknown,
      _timeoutMs: number,
      subscriptionCallbacks: RemoteRuntimeSubscriptionCallbacks
    ) => {
      callbacks = subscriptionCallbacks
      const subscription: RemoteRuntimeSubscription = {
        requestId: 'port-forward',
        close: closeSubscription,
        sendBinary: () => true
      }
      return Promise.resolve(subscription)
    }
  )
  return () => callbacks
}

/** Lets the attach resume past the awaited subscription before the test acts. */
function settleSubscription(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Attaches a transport whose subscription is under this test's control. */
async function attach(onLost: (error: Error) => void) {
  const read = stubSubscription()

  const transport = new PortForwardTransport({ pairing: PAIRING, onLost })
  const starting = transport.start()
  await vi.waitFor(() => expect(read()).toBeDefined())
  read()?.onResponse({
    id: 'port-forward',
    ok: true,
    result: { type: 'ready', tunnelGeneration: 7 },
    _meta: { runtimeId: 'runtime-a' }
  })
  await starting

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: waitFor above settles before the callbacks are read, so the subscription exists by here.
  return { transport, callbacks: read() as RemoteRuntimeSubscriptionCallbacks }
}

describe('PortForwardTransport', () => {
  it('reports a lost tunnel once, not once per teardown hop', async () => {
    const onLost = vi.fn()
    const { callbacks } = await attach(onLost)

    // close() closes the tunnel client, whose onClosed re-enters fail(); an unguarded
    // fail() would report the same loss a second time from that re-entry.
    callbacks.onClose?.()

    expect(onLost).toHaveBeenCalledTimes(1)
  })

  it('does not report a loss for a deliberate close', async () => {
    const onLost = vi.fn()
    const { transport } = await attach(onLost)

    transport.close()

    expect(onLost).not.toHaveBeenCalled()
  })

  it('settles a pending attach when it is closed before readiness', async () => {
    const onLost = vi.fn()
    const read = stubSubscription()
    const transport = new PortForwardTransport({ pairing: PAIRING, onLost })

    const starting = transport.start()
    await vi.waitFor(() => expect(read()).toBeDefined())
    await settleSubscription()
    // Nothing else can settle the attach at this point: the subscription is held but no
    // ready event arrived, and close() short-circuits the failure path.
    transport.close()

    await expect(starting).rejects.toThrow('port_forward_transport_closed')
    expect(onLost).not.toHaveBeenCalled()
  })

  it('refuses to restart once closed', async () => {
    const { transport } = await attach(vi.fn())

    transport.close()

    await expect(transport.start()).rejects.toThrow('port_forward_transport_closed')
  })
})
