import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgePageMessage } from '../../../src/shared/mobile-web/bridge-contract'
import type { RpcClient } from '../transport/rpc-client'
import {
  createMobileWebBrokerFixture,
  mobileWebBridgeCancelMessage,
  mobileWebBridgeRequestMessage
} from './mobile-web-bridge-roundtrip-fixture'

describe('mobile web speech broker', () => {
  it('serves bounded setup metadata through an authenticated once request', async () => {
    const harness = createHarness()
    harness.sendRequest.mockResolvedValue({
      id: 'rpc',
      ok: true,
      result: setup(),
      _meta: { runtimeId: 'runtime' }
    })

    await harness.broker.handle(request('A', 'once', 'setup', {}))

    expect(harness.messages.at(-1)).toMatchObject({
      type: 'response',
      status: 'success',
      payload: setup()
    })
  })

  it('accounts for the single speech subscription and releases it on cancel', async () => {
    const harness = createHarness()
    await harness.broker.handle(request('A', 'subscription', 'subscribe', {}, 'Q'))
    await harness.broker.handle(request('B', 'subscription', 'subscribe', {}, 'R'))
    expect(harness.messages.at(-1)).toMatchObject({
      status: 'error',
      error: { code: 'rate_limited' }
    })

    await harness.broker.handle(cancel('Q'))
    await harness.broker.handle(request('C', 'subscription', 'subscribe', {}, 'T'))

    expect(harness.messages.at(-1)).toMatchObject({
      status: 'success',
      payload: null
    })
  })

  it('rejects a speech payload the operation contract does not accept', async () => {
    const harness = createHarness()

    await harness.broker.handle(request('A', 'once', 'configure', { dictationMode: 'shout' }))

    expect(harness.messages.at(-1)).toMatchObject({ status: 'error' })
    expect(harness.sendRequest).not.toHaveBeenCalled()
  })
})

function createHarness() {
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const client = { sendRequest } as unknown as RpcClient
  const { broker, messages } = createMobileWebBrokerFixture({
    getClient: () => client,
    navigationAuthority: {
      route: vi.fn(),
      reconnect: vi.fn(),
      removeHost: vi.fn()
    },
    now: () => 1000
  })
  return { broker, messages, sendRequest }
}

function request(
  id: string,
  mode: 'once' | 'subscription',
  operation: string,
  payload: unknown,
  subscriptionId = ''
): Extract<MobileWebBridgePageMessage, { type: 'request' }> {
  return mobileWebBridgeRequestMessage({
    requestId: id.repeat(22),
    capability: 'speech',
    operation,
    payload,
    ...(mode === 'subscription' ? { subscriptionId: subscriptionId.repeat(22) } : {})
  })
}

function cancel(id: string): Extract<MobileWebBridgePageMessage, { type: 'cancel' }> {
  return mobileWebBridgeCancelMessage({ target: 'subscription', id: id.repeat(22) })
}

function setup() {
  return {
    enabled: true,
    selectedModelId: 'model-1',
    dictationMode: 'toggle',
    models: [
      {
        id: 'model-1',
        label: 'Model One',
        provider: 'local',
        sizeBytes: 1024,
        recommended: true,
        status: 'ready',
        progress: null
      }
    ]
  }
}
