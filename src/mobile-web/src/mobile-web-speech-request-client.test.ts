import { describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../shared/mobile-web/bridge-contract'
import { MobileWebBridgeClient } from './mobile-web-bridge-client'

const CONTEXT = {
  shellSessionId: 'S'.repeat(43),
  buildId: 'a'.repeat(64)
}

describe('mobile web speech request client', () => {
  it('posts typed setup requests and validates bounded setup responses', async () => {
    const harness = createHarness(['A'])
    const result = harness.client.speech.setup()
    const request = harness.messages[0] as Extract<MobileWebBridgePageMessage, { type: 'request' }>

    expect(request).toMatchObject({
      mode: 'once',
      capability: 'speech',
      operation: 'setup',
      payload: {}
    })
    harness.client.receive(response(request.requestId, setup()))
    await expect(result).resolves.toEqual(setup())
  })

  it('rejects oversized transcripts returned by the native shell', async () => {
    const harness = createHarness(['A'])
    const result = harness.client.speech.stop()
    const request = harness.messages[0] as Extract<MobileWebBridgePageMessage, { type: 'request' }>

    harness.client.receive(
      response(request.requestId, {
        status: 'transcript',
        text: 'a'.repeat(32 * 1024 + 1)
      })
    )

    await expect(result).rejects.toMatchObject({ code: 'invalid_message' })
  })

  it('delivers ordered typed lifecycle events through a speech subscription', async () => {
    const harness = createHarness(['A', 'B'])
    const onEvent = vi.fn()
    const onError = vi.fn()
    const subscription = harness.client.speech.subscribe(onEvent, onError)
    const request = harness.messages[0] as Extract<
      MobileWebBridgePageMessage,
      { type: 'request'; mode: 'subscription' }
    >

    harness.client.receive(response(request.requestId, null))
    await subscription.ready
    harness.client.receive(event(request.subscriptionId, 0, { status: 'recording' }))
    harness.client.receive(event(request.subscriptionId, 1, { status: 'processing' }))

    expect(onEvent.mock.calls.map(([value]) => value)).toEqual([
      { status: 'recording' },
      { status: 'processing' }
    ])
    expect(onError).not.toHaveBeenCalled()
  })
})

function createHarness(ids: string[]) {
  const messages: MobileWebBridgePageMessage[] = []
  const operations = ['setup', 'stop', 'subscribe'].map((operation) => ({
    capability: 'speech' as const,
    operation,
    limits: {
      maxRequestBytes: 256,
      maxResponseBytes: 48 * 1024,
      maxConcurrent: 1,
      rateCapacity: 4,
      rateRefillPerSecond: 1
    }
  }))
  const client = new MobileWebBridgeClient({
    context: CONTEXT,
    grants: operations,
    postMessage: (message) => {
      messages.push(message)
      return true
    },
    createRequestId: () => (ids.shift() ?? 'Z').repeat(22)
  })
  return { client, messages }
}

function response(
  requestId: string,
  payload: unknown
): Extract<MobileWebBridgeShellMessage, { type: 'response' }> {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'response',
    shellSessionId: CONTEXT.shellSessionId,
    buildId: CONTEXT.buildId,
    requestId,
    status: 'success',
    payload
  }
}

function event(
  subscriptionId: string,
  sequence: number,
  payload: unknown
): Extract<MobileWebBridgeShellMessage, { type: 'event' }> {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'event',
    shellSessionId: CONTEXT.shellSessionId,
    buildId: CONTEXT.buildId,
    subscriptionId,
    sequence,
    payload
  }
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
