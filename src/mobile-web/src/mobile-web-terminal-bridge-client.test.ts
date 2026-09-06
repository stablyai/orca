import { expect, it, vi } from 'vitest'
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

it('subscribes by workspace/tab IDs and sends typed terminal ACKs', async () => {
  const messages: MobileWebBridgePageMessage[] = []
  const ids = ['Q'.repeat(22), 'T'.repeat(22), 'A'.repeat(22)]
  const onEvent = vi.fn()
  const client = new MobileWebBridgeClient({
    context: CONTEXT,
    grants: [grant('subscribe'), grant('ack')],
    postMessage: (message) => {
      messages.push(message)
      return true
    },
    createRequestId: () => ids.shift() ?? 'Z'.repeat(22)
  })

  const subscription = client.terminalSubscribe(
    {
      operation: 'subscribe',
      workspaceId: 'workspace-1',
      tabId: 'tab-1',
      viewport: { cols: 80, rows: 24 },
      visible: true
    },
    onEvent,
    vi.fn()
  )
  expect(subscription.streamId).toBe('T'.repeat(22))
  expect(messages[0]).toMatchObject({
    type: 'request',
    mode: 'subscription',
    capability: 'terminal',
    operation: 'subscribe',
    payload: {
      workspaceId: 'workspace-1',
      tabId: 'tab-1'
    }
  })
  client.receive(response('Q'.repeat(22), null))
  await subscription.ready

  client.receive({
    ...envelope(),
    type: 'event',
    subscriptionId: subscription.streamId,
    sequence: 0,
    payload: {
      type: 'subscribed',
      streamId: subscription.streamId,
      viewport: { cols: 80, rows: 24 },
      startSequence: 0,
      maxOutstandingBytes: 256 * 1024,
      queryReplyNegotiated: true
    }
  })
  expect(onEvent).toHaveBeenCalledOnce()

  const ack = client.terminalRequest({
    operation: 'ack',
    streamId: subscription.streamId,
    throughSequence: 5
  })
  expect(messages.at(-1)).toMatchObject({
    type: 'request',
    mode: 'once',
    capability: 'terminal',
    operation: 'ack'
  })
  client.receive(response('A'.repeat(22), null))
  await expect(ack).resolves.toBeNull()
})

function grant(operation: 'subscribe' | 'ack') {
  return {
    capability: 'terminal' as const,
    operation,
    limits: {
      maxRequestBytes: 4096,
      maxResponseBytes: 1024,
      maxConcurrent: 4,
      rateCapacity: 20,
      rateRefillPerSecond: 20
    }
  }
}

function envelope() {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    shellSessionId: CONTEXT.shellSessionId,
    buildId: CONTEXT.buildId
  } as const
}

function response(
  requestId: string,
  payload: unknown
): Extract<MobileWebBridgeShellMessage, { type: 'response' }> {
  return {
    ...envelope(),
    type: 'response',
    requestId,
    status: 'success',
    payload
  }
}
